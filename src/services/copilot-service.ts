import fetch from 'node-fetch';
import { v4 as uuidv4 } from 'uuid';
import { config } from '../config/index.js';
import {
  OpenAIMessage,
  OpenAICompletionRequest,
  ResponsesInput,
  ResponsesContentPart,
  Tool,
  ToolCall
} from '../types/openai.js';
import { CopilotCompletionResponse } from '../types/github.js';
import { getMachineId } from '../utils/machine-id.js';
import { logger } from '../utils/logger.js';

const MODEL_MAPPING: Record<string, string> = {
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
  'gpt-4o': 'gpt-4o',
  'gpt-4o-mini': 'gpt-4o-mini',
  'gpt-4.1': 'gpt-4.1',
  'gpt-4-turbo': 'gpt-4-0125-preview',
  'gpt-4': 'gpt-4',
  'gpt-3.5-turbo': 'gpt-3.5-turbo',
  'gpt-5.2': 'gpt-5.2',
  'gpt-5-codex': 'gpt-5-codex',
  'gpt-5.1-codex-max': 'gpt-5.1-codex-max',
  'gemini-2.5-pro': 'gemini-2.5-pro',
  'gemini-3-pro': 'gemini-3-pro-preview',
  'gemini-3-pro-preview': 'gemini-3-pro-preview',
  'gemini-3-flash': 'gemini-3-flash-preview',
  'gemini-3-flash-preview': 'gemini-3-flash-preview',
  'o1': 'o1-preview',
  'o1-preview': 'o1-preview',
  'o1-mini': 'o1-mini',
  'o3-mini': 'o3-mini',
  'default': 'gpt-4o'
};

export function mapToCopilotModel(requestedModel: string): string {
  const mapped = MODEL_MAPPING[requestedModel.toLowerCase()];
  if (mapped) {
    logger.debug('Model mapped', { from: requestedModel, to: mapped });
    return mapped;
  }
  logger.warn('Unknown model requested, using as-is', { requestedModel });
  return requestedModel;
}

// Convert tools from various formats (Responses API, custom, etc.) to Copilot-compatible format
export function convertToolsForCopilot(tools?: any[]): Tool[] | undefined {
  if (!tools || tools.length === 0) return undefined;
  
  const convertedTools: Tool[] = [];
  
  for (const tool of tools) {
    // Skip invalid tools
    if (!tool) continue;
    
    // Handle standard function type
    if (tool.type === 'function' && tool.function) {
      // Ensure the function has a valid name
      if (tool.function.name && typeof tool.function.name === 'string' && tool.function.name.length > 0) {
        convertedTools.push({
          type: 'function' as const,
          function: {
            name: tool.function.name,
            description: tool.function.description || '',
            parameters: tool.function.parameters || { type: 'object', properties: {} },
            strict: tool.function.strict
          }
        });
      } else {
        logger.warn('Skipping tool with invalid function name', { tool });
      }
    }
    // Handle custom type (some APIs use this)
    else if (tool.type === 'custom' && tool.custom) {
      if (tool.custom.name && typeof tool.custom.name === 'string' && tool.custom.name.length > 0) {
        convertedTools.push({
          type: 'function' as const,
          function: {
            name: tool.custom.name,
            description: tool.custom.description || '',
            parameters: tool.custom.parameters || { type: 'object', properties: {} }
          }
        });
      } else {
        logger.warn('Skipping custom tool with invalid name', { tool });
      }
    }
    // Handle direct function definition (legacy format)
    else if (tool.name && typeof tool.name === 'string') {
      convertedTools.push({
        type: 'function' as const,
        function: {
          name: tool.name,
          description: tool.description || '',
          parameters: tool.parameters || { type: 'object', properties: {} }
        }
      });
    }
    // Handle web_search_preview and other special types - skip these
    else if (tool.type === 'web_search_preview' || tool.type === 'code_interpreter' || tool.type === 'file_search') {
      logger.debug('Skipping unsupported tool type', { toolType: tool.type });
    }
    else {
      logger.warn('Skipping tool with unrecognized format', { tool });
    }
  }
  
  if (convertedTools.length === 0) {
    return undefined;
  }
  
  logger.debug('Tools converted for Copilot', { 
    originalCount: tools.length, 
    convertedCount: convertedTools.length,
    toolNames: convertedTools.map(t => t.function.name)
  });
  
  return convertedTools;
}

export async function makeCompletionRequest(
  request: OpenAICompletionRequest,
  copilotToken: string
): Promise<CopilotCompletionResponse> {
  const { model, messages, temperature, max_tokens, top_p, n, tools, tool_choice, parallel_tool_calls } = request;
  const machineId = getMachineId();
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

  const copilotModel = mapToCopilotModel(model || 'gpt-4o');

  const body: Record<string, any> = {
    model: copilotModel,
    messages,
    max_tokens: max_tokens || 4096,
    temperature: temperature || 0.7,
    top_p: top_p || 1,
    n: n || 1,
    stream: false
  };

  if (tools && tools.length > 0) {
    body.tools = convertToolsForCopilot(tools);
    logger.debug('Including tools in request', { toolCount: tools.length, toolNames: tools.map(t => t.function.name) });
  }

  if (tool_choice) {
    body.tool_choice = tool_choice;
  }

  if (parallel_tool_calls !== undefined) {
    body.parallel_tool_calls = parallel_tool_calls;
  }

  try {
    logger.debug('Making chat completion request to Copilot', { 
      chatUrl, 
      model: copilotModel, 
      hasTools: !!tools,
      toolChoice: tool_choice 
    });
    
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

export function convertResponsesInputToMessages(
  input: string | ResponsesInput[],
  instructions?: string
): OpenAIMessage[] {
  const messages: OpenAIMessage[] = [];

  if (instructions) {
    messages.push({ role: 'system', content: instructions });
  }

  if (typeof input === 'string') {
    messages.push({ role: 'user', content: input });
    return messages;
  }

  if (Array.isArray(input)) {
    for (const item of input) {
      if (item.type === 'function_call_output') {
        messages.push({
          role: 'tool',
          content: item.output || '',
          tool_call_id: item.call_id
        });
        continue;
      }

      if (item.type === 'message' || (item.role && !item.type)) {
        let content: string;
        
        if (typeof item.content === 'string') {
          content = item.content;
        } else if (Array.isArray(item.content)) {
          content = item.content
            .filter((part): part is ResponsesContentPart =>
              part.type === 'input_text' || part.type === 'output_text' || part.type === 'text'
            )
            .map(part => part.text)
            .join('');
        } else {
          content = '';
        }

        const itemRole = item.role === 'user' ? 'user' :
                         item.role === 'assistant' ? 'assistant' :
                         item.role === 'system' ? 'system' :
                         item.role === 'developer' ? 'system' : 'user';

        messages.push({
          role: itemRole as 'system' | 'user' | 'assistant' | 'function' | 'tool',
          content
        });
      }
    }
  }

  return messages;
}

export function convertMessagesToCopilotPrompt(messages: OpenAIMessage[]): string {
  if (!messages || !Array.isArray(messages) || messages.length === 0) return '';

  let prompt = '';
  for (const message of messages) {
    if (!message.role || !message.content) continue;
    switch (message.role) {
      case 'system': prompt += message.content + '\n\n'; break;
      case 'user': prompt += 'User: ' + message.content + '\n\n'; break;
      case 'assistant': prompt += 'Assistant: ' + message.content + '\n\n'; break;
    }
  }

  const lastMessage = messages[messages.length - 1];
  const needsAssistantPrompt = lastMessage.role === 'user';
  return prompt + (needsAssistantPrompt ? 'Assistant: ' : '');
}

export function detectLanguageFromMessages(messages: OpenAIMessage[]): string {
  if (!messages || !Array.isArray(messages) || messages.length === 0) return 'javascript';
  const lastUserMessage = [...messages].reverse().find(m => m.role === 'user');
  if (!lastUserMessage || !lastUserMessage.content) return 'javascript';

  const content = lastUserMessage.content;
  const codeBlockMatch = content.match(/```(\w+)/);
  if (codeBlockMatch && codeBlockMatch[1]) return codeBlockMatch[1].toLowerCase();

  const fileExtensionMatch = content.match(/\.([a-zA-Z0-9]+)(?:\s|"|'|$|\?)/);
  if (fileExtensionMatch && fileExtensionMatch[1]) {
    const ext = fileExtensionMatch[1].toLowerCase();
    const extToLang: Record<string, string> = {
      'js': 'javascript', 'ts': 'typescript', 'py': 'python', 'java': 'java',
      'c': 'c', 'cpp': 'cpp', 'cs': 'csharp', 'go': 'go', 'rb': 'ruby',
      'php': 'php', 'html': 'html', 'css': 'css', 'json': 'json', 'md': 'markdown'
    };
    return extToLang[ext] || 'javascript';
  }
  return 'javascript';
}
