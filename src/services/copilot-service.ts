import fetch from 'node-fetch';
import { v4 as uuidv4 } from 'uuid';
import { config } from '../config/index.js';
import { 
  OpenAIMessage, 
  OpenAICompletionRequest,
  ResponsesInput,
  ResponsesContentPart
} from '../types/openai.js';
import { CopilotCompletionResponse } from '../types/github.js';
import { getMachineId } from '../utils/machine-id.js';
import { logger } from '../utils/logger.js';

/**
 * Model name mapping from client-requested names to Copilot API model names
 * Based on actual Copilot API /models endpoint response
 * Copilot uses "claude-{tier}-{version}" format (e.g., claude-opus-4.5)
 */
const MODEL_MAPPING: Record<string, string> = {
  // Claude models - Copilot uses "claude-{tier}-{version}" format
  'claude-4.5-opus': 'claude-opus-4.5',
  'claude-opus-4.5': 'claude-opus-4.5',
  'claude-4-opus': 'claude-opus-4.5',
  'claude-opus-4': 'claude-opus-4.5',
  'claude-4.5-sonnet': 'claude-sonnet-4.5',
  'claude-sonnet-4.5': 'claude-sonnet-4.5',
  'claude-4-sonnet': 'claude-sonnet-4',
  'claude-sonnet-4': 'claude-sonnet-4',
  'claude-4.5-haiku': 'claude-haiku-4.5',
  'claude-haiku-4.5': 'claude-haiku-4.5',
  'claude-3.5-sonnet': 'claude-sonnet-4',
  'claude-3-opus': 'claude-opus-4.5',
  'claude-3-sonnet': 'claude-sonnet-4',
  
  // GPT models
  'gpt-4o': 'gpt-4o',
  'gpt-4o-mini': 'gpt-4o-mini',
  'gpt-4.1': 'gpt-4.1',
  'gpt-4-turbo': 'gpt-4-0125-preview',
  'gpt-4': 'gpt-4',
  'gpt-3.5-turbo': 'gpt-3.5-turbo',
  'gpt-5.2': 'gpt-5.2',
  'gpt-5-codex': 'gpt-5-codex',
  'gpt-5.1-codex-max': 'gpt-5.1-codex-max',
  
  // Gemini models
  'gemini-2.5-pro': 'gemini-2.5-pro',
  'gemini-3-pro': 'gemini-3-pro-preview',
  'gemini-3-pro-preview': 'gemini-3-pro-preview',
  'gemini-3-flash': 'gemini-3-flash-preview',
  'gemini-3-flash-preview': 'gemini-3-flash-preview',
  
  // o1/o3 reasoning models
  'o1': 'o1-preview',
  'o1-preview': 'o1-preview',
  'o1-mini': 'o1-mini',
  'o3-mini': 'o3-mini',
  
  // Default fallback
  'default': 'gpt-4o'
};

/**
 * Maps a client-requested model name to a valid Copilot API model name
 * 
 * @param requestedModel The model name requested by the client
 * @returns A valid Copilot API model name
 */
export function mapToCopilotModel(requestedModel: string): string {
  const mapped = MODEL_MAPPING[requestedModel.toLowerCase()];
  if (mapped) {
    logger.debug('Model mapped', { from: requestedModel, to: mapped });
    return mapped;
  }
  
  // If no mapping found, try to use the model as-is or default to gpt-4o
  logger.warn('Unknown model requested, using default', { requestedModel, default: 'gpt-4o' });
  return 'gpt-4o';
}

/**
 * Converts OpenAI messages format to GitHub Copilot prompt format
 * 
 * @param messages Array of OpenAI messages
 * @returns Formatted prompt string for Copilot
 */
export function convertMessagesToCopilotPrompt(messages: OpenAIMessage[]): string {
  if (!messages || !Array.isArray(messages) || messages.length === 0) {
    return '';
  }
  
  let prompt = '';
  
  // Process messages in order to preserve conversation flow
  for (const message of messages) {
    if (!message.role || !message.content) continue;
    
    switch (message.role) {
      case 'system':
        prompt += message.content + '\n\n';
        break;
      case 'user':
        prompt += 'User: ' + message.content + '\n\n';
        break;
      case 'assistant':
        prompt += 'Assistant: ' + message.content + '\n\n';
        break;
    }
  }
  
  // Ensure it ends with a user message to prompt a response
  const lastMessage = messages[messages.length - 1];
  const needsAssistantPrompt = lastMessage.role === 'user';
  
  return prompt + (needsAssistantPrompt ? 'Assistant: ' : '');
}

/**
 * Detects programming language from the message content
 * 
 * @param messages Array of OpenAI messages
 * @returns Detected language or default to javascript
 */
export function detectLanguageFromMessages(messages: OpenAIMessage[]): string {
  if (!messages || !Array.isArray(messages) || messages.length === 0) {
    return 'javascript';
  }
  
  const lastUserMessage = [...messages].reverse().find(m => m.role === 'user');
  if (!lastUserMessage || !lastUserMessage.content) {
    return 'javascript';
  }
  
  const content = lastUserMessage.content;
  
  // Check for code blocks with language specifications
  const codeBlockMatch = content.match(/```(\w+)/);
  if (codeBlockMatch && codeBlockMatch[1]) {
    return codeBlockMatch[1].toLowerCase();
  }
  
  // Check for file extensions in the message (followed by space, quote, or end of word boundary)
  const fileExtensionMatch = content.match(/\.([a-zA-Z0-9]+)(?:\s|"|'|$|\?)/);
  if (fileExtensionMatch && fileExtensionMatch[1]) {
    const ext = fileExtensionMatch[1].toLowerCase();
    const extToLang: Record<string, string> = {
      'js': 'javascript',
      'ts': 'typescript',
      'py': 'python',
      'java': 'java',
      'c': 'c',
      'cpp': 'cpp',
      'cs': 'csharp',
      'go': 'go',
      'rb': 'ruby',
      'php': 'php',
      'html': 'html',
      'css': 'css',
      'json': 'json',
      'md': 'markdown'
    };
    return extToLang[ext] || 'javascript';
  }
  
  return 'javascript';
}

/**
 * Makes a non-streaming request to GitHub Copilot Chat API
 * 
 * @param request OpenAI-format completion request
 * @param copilotToken Copilot authentication token
 * @returns Promise with the completion response
 */
export async function makeCompletionRequest(
  request: OpenAICompletionRequest,
  copilotToken: string
): Promise<CopilotCompletionResponse> {
  const { model, messages, temperature, max_tokens, top_p, n } = request;
  
  // Get machine ID for request
  const machineId = getMachineId();
  
  // Use chat completions endpoint for chat requests
  const chatUrl = config.github.copilot.apiEndpoints.GITHUB_COPILOT_CHAT;
  const headers = {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${copilotToken}`,
    'X-Request-Id': uuidv4(),
    'Vscode-Machineid': machineId,
    'Vscode-Sessionid': uuidv4(),
    'User-Agent': 'GitHubCopilotChat/0.22.2',
    'Editor-Version': 'vscode/1.96.0',
    'Editor-Plugin-Version': 'copilot-chat/0.22.2',
    'Copilot-Integration-Id': 'vscode-chat',
    'Openai-Intent': 'conversation-agent'
  };
  
  // Map the requested model to a valid Copilot model
  const copilotModel = mapToCopilotModel(model || 'gpt-4o');
  
  // Use OpenAI chat completions format
  const body = {
    model: copilotModel,
    messages,
    max_tokens: max_tokens || 4096,
    temperature: temperature || 0.7,
    top_p: top_p || 1,
    n: n || 1,
    stream: false
  };
  
  try {
    logger.debug('Making chat completion request to Copilot', { chatUrl, model: copilotModel, requestedModel: model });
    
    const response = await fetch(chatUrl, {
      method: 'POST',
      headers,
      body: JSON.stringify(body)
    });
    
    if (!response.ok) {
      const errorText = await response.text();
      logger.error('Copilot API error', { 
        status: response.status, 
        statusText: response.statusText,
        error: errorText
      });
      throw new Error(`Copilot API error: ${response.status} ${response.statusText}`);
    }
    
    const data = await response.json() as CopilotCompletionResponse;
    return data;
  } catch (error) {
    logger.error('Error making completion request', { error });
    throw error;
  }
}

/**
 * Converts OpenAI Responses API input to standard OpenAI messages format
 * 
 * @param input Responses API input (string or array of ResponsesInput)
 * @param instructions Optional system instructions
 * @returns Array of OpenAI messages
 */
export function convertResponsesInputToMessages(
  input: string | ResponsesInput[],
  instructions?: string
): OpenAIMessage[] {
  const messages: OpenAIMessage[] = [];
  
  // Add system instructions if provided
  if (instructions) {
    messages.push({
      role: 'system',
      content: instructions
    });
  }
  
  // Handle simple string input
  if (typeof input === 'string') {
    messages.push({
      role: 'user',
      content: input
    });
    return messages;
  }
  
  // Handle array of ResponsesInput or OpenAI-style messages
  if (Array.isArray(input)) {
    for (const item of input) {
      let content: string;
      let itemRole: string;
      
      // Check if this is Responses API format (has type: 'message') or OpenAI-style (has role directly)
      if (item.type === 'message' || (item.role && !item.type)) {
        // Handle content - can be string or array of content parts
        if (typeof item.content === 'string') {
          content = item.content;
        } else if (Array.isArray(item.content)) {
          // Extract text from content parts
          content = item.content
            .filter((part): part is ResponsesContentPart => 
              part.type === 'input_text' || part.type === 'output_text' || part.type === 'text'
            )
            .map(part => part.text)
            .join('');
        } else {
          content = '';
        }
        
        // Map Responses API roles to OpenAI message roles
        itemRole = item.role === 'user' ? 'user' : 
                   item.role === 'assistant' ? 'assistant' : 
                   item.role === 'system' ? 'system' : 
                   item.role === 'developer' ? 'system' : 'user';
        
        messages.push({
          role: itemRole as 'system' | 'user' | 'assistant' | 'function',
          content
        });
      }
    }
  }
  
  return messages;
}
