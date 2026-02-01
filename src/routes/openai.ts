import express from 'express';
import fetch from 'node-fetch';
import { createParser, type EventSourceMessage } from 'eventsource-parser';
import { v4 as uuidv4 } from 'uuid';
import { 
  isTokenValid, 
  getCopilotToken,
  refreshCopilotToken,
  hasGithubToken
} from '../services/auth-service.js';
import { 
  convertMessagesToCopilotPrompt,
  detectLanguageFromMessages,
  makeCompletionRequest,
  convertResponsesInputToMessages,
  mapToCopilotModel
} from '../services/copilot-service.js';
import { 
  OpenAICompletionRequest, 
  OpenAICompletion,
  ResponsesRequest,
  ResponsesResponse,
  ResponsesOutput,
  OpenAIMessage
} from '../types/openai.js';
import { AppError } from '../middleware/error-handler.js';
import { config } from '../config/index.js';
import { getMachineId } from '../utils/machine-id.js';
import { logger } from '../utils/logger.js';
import { trackRequest } from '../services/usage-service.js';

export const openaiRoutes = express.Router();

// Authentication middleware
const requireAuth = async (req: express.Request, res: express.Response, next: express.NextFunction) => {
  try {
    // If token is valid, proceed
    if (isTokenValid()) {
      return next();
    }
    
    // Try to refresh token if we have a GitHub token
    if (hasGithubToken()) {
      logger.debug('Token expired, attempting refresh...');
      try {
        await refreshCopilotToken();
        logger.info('Token refreshed successfully');
        return next();
      } catch (refreshError) {
        logger.error('Token refresh failed:', refreshError);
        // Fall through to return 401
      }
    }
    
    // No valid token and couldn't refresh
    const error = new Error('Authentication required') as AppError;
    error.status = 401;
    error.code = 'authentication_required';
    return next(error);
  } catch (error) {
    logger.error('Auth middleware error:', error);
    const authError = new Error('Authentication failed') as AppError;
    authError.status = 401;
    authError.code = 'authentication_failed';
    next(authError);
  }
};

// GET /v1/models - List available models
openaiRoutes.get('/models', requireAuth, (req, res) => {
  // Return models available from GitHub Copilot API
  const timestamp = Math.floor(Date.now() / 1000);
  res.json({
    object: 'list',
    data: [
      // Claude Models (Anthropic)
      {
        id: 'claude-opus-4.5',
        object: 'model',
        created: timestamp,
        owned_by: 'anthropic',
      },
      {
        id: 'claude-sonnet-4.5',
        object: 'model',
        created: timestamp,
        owned_by: 'anthropic',
      },
      {
        id: 'claude-sonnet-4',
        object: 'model',
        created: timestamp,
        owned_by: 'anthropic',
      },
      {
        id: 'claude-haiku-4.5',
        object: 'model',
        created: timestamp,
        owned_by: 'anthropic',
      },
      // GPT Models (OpenAI/Azure)
      {
        id: 'gpt-4o',
        object: 'model',
        created: timestamp,
        owned_by: 'azure-openai',
      },
      {
        id: 'gpt-4o-mini',
        object: 'model',
        created: timestamp,
        owned_by: 'azure-openai',
      },
      {
        id: 'gpt-4.1',
        object: 'model',
        created: timestamp,
        owned_by: 'azure-openai',
      },
      {
        id: 'gpt-4',
        object: 'model',
        created: timestamp,
        owned_by: 'azure-openai',
      },
      {
        id: 'gpt-3.5-turbo',
        object: 'model',
        created: timestamp,
        owned_by: 'azure-openai',
      },
      {
        id: 'gpt-5.2',
        object: 'model',
        created: timestamp,
        owned_by: 'openai',
      },
      {
        id: 'gpt-5-codex',
        object: 'model',
        created: timestamp,
        owned_by: 'openai',
      },
      // Gemini Models (Google)
      {
        id: 'gemini-2.5-pro',
        object: 'model',
        created: timestamp,
        owned_by: 'google',
      },
      {
        id: 'gemini-3-pro-preview',
        object: 'model',
        created: timestamp,
        owned_by: 'google',
      },
      {
        id: 'gemini-3-flash-preview',
        object: 'model',
        created: timestamp,
        owned_by: 'google',
      },
      // o1/o3 Reasoning Models
      {
        id: 'o1-preview',
        object: 'model',
        created: timestamp,
        owned_by: 'openai',
      },
      {
        id: 'o1-mini',
        object: 'model',
        created: timestamp,
        owned_by: 'openai',
      },
      {
        id: 'o3-mini',
        object: 'model',
        created: timestamp,
        owned_by: 'openai',
      }
    ]
  });
});

// POST /v1/chat/completions - Create a completion
openaiRoutes.post('/chat/completions', requireAuth, async (req, res, next) => {
  // Track this request
  const sessionId = res.locals.sessionId;
  trackRequest(sessionId, 0); // Initial tracking, token count will be updated later
  try {
    const request = req.body as OpenAICompletionRequest;
    const { messages, stream = false, model = 'gpt-4' } = request;
    
    // Validate request
    if (!messages || !Array.isArray(messages) || messages.length === 0) {
      const error = new Error('Messages array is required') as AppError;
      error.status = 400;
      error.code = 'invalid_request';
      return next(error);
    }
    
    const copilotToken = getCopilotToken();
    if (!copilotToken) {
      const error = new Error('Authentication required') as AppError;
      error.status = 401;
      error.code = 'authentication_required';
      return next(error);
    }
    
    // Handle streaming response
    if (stream) {
      handleStreamingCompletion(req, res, next, sessionId);
    } else {
      // Handle non-streaming response
      try {
        const completionData = await makeCompletionRequest(request, copilotToken.token);
        
        // Convert to OpenAI format
        const openAIResponse: OpenAICompletion = {
          id: `chatcmpl-${uuidv4()}`,
          object: 'chat.completion',
          created: Math.floor(Date.now() / 1000),
          model,
          choices: completionData.choices.map((choice, index) => ({
            index,
            message: {
              role: 'assistant',
              content: choice.text,
            },
            finish_reason: choice.finish_reason || 'stop',
          })),
          usage: completionData.usage
        };
        
        // Track token usage
        const totalTokens = openAIResponse.usage?.total_tokens || 0;
        trackRequest(sessionId, totalTokens);
        
        res.json(openAIResponse);
      } catch (error) {
        logger.error('Error in non-streaming completion:', error);
        next(error);
      }
    }
  } catch (error) {
    next(error);
  }
});

// Handle streaming completions
async function handleStreamingCompletion(
  req: express.Request, 
  res: express.Response, 
  next: express.NextFunction,
  sessionId: string
) {
  try {
    const request = req.body as OpenAICompletionRequest;
    const { messages, temperature, max_tokens, top_p, n, model = 'gpt-4' } = request;
    
    const copilotToken = getCopilotToken();
    if (!copilotToken || !copilotToken.token) {
      const error = new Error('Authentication required') as AppError;
      error.status = 401;
      error.code = 'authentication_required';
      return next(error);
    }
    
    // Get machine ID for request
    const machineId = getMachineId();
    
    // Set appropriate headers for SSE
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no'); // Disable nginx buffering
    res.flushHeaders(); // Ensure headers are sent immediately
    
    const chatUrl = config.github.copilot.apiEndpoints.GITHUB_COPILOT_CHAT;
    
    // Make streaming request using node-fetch with chat completions format
    const response = await fetch(chatUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${copilotToken.token}`,
        'X-Request-Id': uuidv4(),
        'Vscode-Machineid': machineId,
        'Vscode-Sessionid': sessionId,
        'User-Agent': 'GitHubCopilotChat/0.22.2',
        'Editor-Version': 'vscode/1.96.0',
        'Editor-Plugin-Version': 'copilot-chat/0.22.2',
        'Copilot-Integration-Id': 'vscode-chat',
        'Openai-Intent': 'conversation-agent'
      },
      body: JSON.stringify({
        model: mapToCopilotModel(model || 'gpt-4o'),
        messages,
        max_tokens: max_tokens || 4096,
        temperature: temperature || 0.7,
        top_p: top_p || 1,
        n: n || 1,
        stream: true
      }),
    });

    if (!response.ok) {
      logger.error('Stream connection error', {
        status: response.status,
        statusText: response.statusText
      });
      throw new Error(`Stream connection error: ${response.status} ${response.statusText}`);
    }

    if (!response.body) {
      throw new Error('No response body');
    }

    // Create SSE parser (v3.x API)
    const parser = createParser({
      onEvent(event: EventSourceMessage) {
        const data = event.data;
        
        if (data === '[DONE]') {
          res.write('data: [DONE]\n\n');
          return;
        }
        
        try {
          // Parse the data - chat completions format
          const parsed = JSON.parse(data);
          
          // Chat completions uses delta.content, not text
          const content = parsed.choices?.[0]?.delta?.content || '';
          
          // Convert to ChatCompletions format
          const openAiFormatted = {
            id: parsed.id || `chatcmpl-${uuidv4()}`,
            object: 'chat.completion.chunk',
            created: parsed.created || Math.floor(Date.now() / 1000),
            model: parsed.model || model,
            choices: [
              {
                index: 0,
                delta: {
                  content: content
                },
                finish_reason: parsed.choices?.[0]?.finish_reason || null
              }
            ]
          };
          
          res.write(`data: ${JSON.stringify(openAiFormatted)}\n\n`);
        
          // Note: For streaming, we don't have accurate token counts
          // We'll estimate based on response length
          if (content) {
            const estimatedTokens = Math.ceil(content.length / 4);
            trackRequest(sessionId, estimatedTokens);
          }
        } catch (error) {
          logger.error('Error parsing stream message:', error);
          res.write(`data: ${JSON.stringify({ error: String(error) })}\n\n`);
        }
      }
    });

    // Process the stream
    const reader = response.body;
    reader.on('data', (chunk: Buffer) => {
      parser.feed(chunk.toString());
    });

    reader.on('end', () => {
      res.end();
    });

    reader.on('error', (err: Error) => {
      logger.error('SSE stream error:', err);
      res.write(`data: ${JSON.stringify({ error: String(err) })}\n\n`);
      res.end();
    });

  } catch (error) {
    logger.error('Error in streaming completion:', error);
    
    // Try to send error to client if response headers haven't been sent
    if (!res.headersSent) {
      return next(error);
    }
    
    // Otherwise try to write error to stream
    try {
      res.write(`data: ${JSON.stringify({ error: String(error) })}\n\n`);
      res.end();
    } catch (streamError) {
      logger.error('Error sending error response to stream:', streamError);
    }
  }
}

// POST /v1/responses - OpenAI Responses API (newer format)
openaiRoutes.post('/responses', requireAuth, async (req, res, next) => {
  const sessionId = res.locals.sessionId || 'default';
  trackRequest(sessionId, 0);
  
  try {
    const request = req.body as ResponsesRequest;
    const { input, instructions, stream = false, model = 'gpt-4' } = request;
    
    logger.debug('Responses API request', { 
      stream, 
      model, 
      hasInput: !!input,
      inputType: typeof input 
    });
    
    // Validate request
    if (!input) {
      const error = new Error('Input is required') as AppError;
      error.status = 400;
      error.code = 'invalid_request';
      return next(error);
    }
    
    const copilotToken = getCopilotToken();
    if (!copilotToken) {
      const error = new Error('Authentication required') as AppError;
      error.status = 401;
      error.code = 'authentication_required';
      return next(error);
    }
    
    // Convert Responses API input to OpenAI messages format
    const messages = convertResponsesInputToMessages(input, instructions);
    
    // Handle streaming response
    if (stream) {
      handleStreamingResponses(req, res, next, sessionId, messages, model);
    } else {
      // Handle non-streaming response
      try {
        const completionRequest: OpenAICompletionRequest = {
          model,
          messages,
          temperature: request.temperature,
          max_tokens: request.max_output_tokens,
          top_p: request.top_p,
        };
        
        const completionData = await makeCompletionRequest(completionRequest, copilotToken.token);
        
        // Convert to Responses API format
        const responseId = `resp_${uuidv4()}`;
        const outputId = `msg_${uuidv4()}`;
        
        const responseOutput: ResponsesOutput = {
          type: 'message',
          id: outputId,
          status: 'completed',
          role: 'assistant',
          content: completionData.choices.map(choice => ({
            type: 'output_text' as const,
            text: choice.text
          }))
        };
        
        const response: ResponsesResponse = {
          id: responseId,
          object: 'response',
          created_at: Math.floor(Date.now() / 1000),
          model,
          status: 'completed',
          output: [responseOutput],
          usage: completionData.usage ? {
            input_tokens: completionData.usage.prompt_tokens,
            output_tokens: completionData.usage.completion_tokens,
            total_tokens: completionData.usage.total_tokens
          } : undefined,
          metadata: request.metadata
        };
        
        // Track token usage
        const totalTokens = response.usage?.total_tokens || 0;
        trackRequest(sessionId, totalTokens);
        
        res.json(response);
      } catch (error) {
        logger.error('Error in non-streaming responses:', error);
        next(error);
      }
    }
  } catch (error) {
    next(error);
  }
});

// Handle streaming for Responses API
async function handleStreamingResponses(
  req: express.Request,
  res: express.Response,
  next: express.NextFunction,
  sessionId: string,
  messages: OpenAIMessage[],
  model: string
) {
  try {
    const request = req.body as ResponsesRequest;
    
    const copilotToken = getCopilotToken();
    if (!copilotToken || !copilotToken.token) {
      const error = new Error('Authentication required') as AppError;
      error.status = 401;
      error.code = 'authentication_required';
      return next(error);
    }
    
    const machineId = getMachineId();
    
    // Set appropriate headers for SSE
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no'); // Disable nginx buffering
    res.flushHeaders(); // Ensure headers are sent immediately
    
    const chatUrl = config.github.copilot.apiEndpoints.GITHUB_COPILOT_CHAT;
    const responseId = `resp_${uuidv4()}`;
    const outputId = `msg_${uuidv4()}`;
    const contentPartId = `cp_${uuidv4()}`;
    let accumulatedText = '';
    let firstChunk = true;
    let completionSent = false;
    
    // Send initial response.created event
    res.write(`event: response.created\ndata: ${JSON.stringify({
      type: 'response.created',
      response: {
        id: responseId,
        object: 'response',
        created_at: Math.floor(Date.now() / 1000),
        model,
        status: 'in_progress',
        output: []
      }
    })}\n\n`);
    
    // Make streaming request using node-fetch with chat completions format
    const response = await fetch(chatUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${copilotToken.token}`,
        'X-Request-Id': uuidv4(),
        'Vscode-Machineid': machineId,
        'Vscode-Sessionid': sessionId,
        'User-Agent': 'GitHubCopilotChat/0.22.2',
        'Editor-Version': 'vscode/1.96.0',
        'Editor-Plugin-Version': 'copilot-chat/0.22.2',
        'Copilot-Integration-Id': 'vscode-chat',
        'Openai-Intent': 'conversation-agent'
      },
      body: JSON.stringify({
        model: mapToCopilotModel(model || 'gpt-4o'),
        messages,
        max_tokens: request.max_output_tokens || 4096,
        temperature: request.temperature || 0.7,
        top_p: request.top_p || 1,
        n: 1,
        stream: true
      }),
    });

    if (!response.ok) {
      logger.error('Stream connection error', {
        status: response.status,
        statusText: response.statusText
      });
      throw new Error(`Stream connection error: ${response.status} ${response.statusText}`);
    }

    if (!response.body) {
      throw new Error('No response body');
    }

    // Create SSE parser (v3.x API)
    const parser = createParser({
      onEvent(event: EventSourceMessage) {
        const data = event.data;
        
        if (data === '[DONE]') {
          if (completionSent) return;
          completionSent = true;
          
          // Send response.output_text.done
          res.write(`event: response.output_text.done\ndata: ${JSON.stringify({
            type: 'response.output_text.done',
            item_id: outputId,
            output_index: 0,
            content_index: 0,
            text: accumulatedText
          })}\n\n`);
          
          // Send response.output_item.done
          res.write(`event: response.output_item.done\ndata: ${JSON.stringify({
            type: 'response.output_item.done',
            item: {
              type: 'message',
              id: outputId,
              status: 'completed',
              role: 'assistant',
              content: [{ type: 'output_text', text: accumulatedText }]
            },
            output_index: 0
          })}\n\n`);
          
          // Send response.completed event
          res.write(`event: response.completed\ndata: ${JSON.stringify({
            type: 'response.completed',
            response: {
              id: responseId,
              object: 'response',
              created_at: Math.floor(Date.now() / 1000),
              model,
              status: 'completed',
              output: [{
                type: 'message',
                id: outputId,
                status: 'completed',
                role: 'assistant',
                content: [{ type: 'output_text', text: accumulatedText }]
              }]
            }
          })}\n\n`);
          
          // Send response.done (final event)
          res.write(`event: response.done\ndata: ${JSON.stringify({
            type: 'response.done',
            response: {
              id: responseId,
              object: 'response',
              created_at: Math.floor(Date.now() / 1000),
              model,
              status: 'completed',
              output: [{
                type: 'message',
                id: outputId,
                status: 'completed',
                role: 'assistant',
                content: [{ type: 'output_text', text: accumulatedText }]
              }]
            }
          })}\n\n`);
          return;
        }
        
        try {
          const parsed = JSON.parse(data);
          // Chat completions uses delta.content, not text
          const text = parsed.choices?.[0]?.delta?.content || '';
          
          if (text) {
            // On first chunk, send output_item.added and content_part.added
            if (firstChunk) {
              firstChunk = false;
              
              // Send response.output_item.added
              res.write(`event: response.output_item.added\ndata: ${JSON.stringify({
                type: 'response.output_item.added',
                item: {
                  type: 'message',
                  id: outputId,
                  status: 'in_progress',
                  role: 'assistant',
                  content: []
                },
                output_index: 0
              })}\n\n`);
              
              // Send response.content_part.added
              res.write(`event: response.content_part.added\ndata: ${JSON.stringify({
                type: 'response.content_part.added',
                item_id: outputId,
                output_index: 0,
                content_index: 0,
                part: {
                  type: 'output_text',
                  text: ''
                }
              })}\n\n`);
            }
            
            accumulatedText += text;
            
            // Send response.output_text.delta event
            const deltaEvent = {
              type: 'response.output_text.delta',
              item_id: outputId,
              output_index: 0,
              content_index: 0,
              delta: text
            };
            res.write(`event: response.output_text.delta\ndata: ${JSON.stringify(deltaEvent)}\n\n`);
            logger.debug('Sent delta event', { text: text.substring(0, 50) });
            
            // Track tokens
            const estimatedTokens = Math.ceil(text.length / 4);
            trackRequest(sessionId, estimatedTokens);
          }
        } catch (error) {
          logger.error('Error parsing stream message:', error);
          res.write(`event: error\ndata: ${JSON.stringify({ 
            type: 'error',
            error: { message: String(error) } 
          })}\n\n`);
        }
      }
    });

    // Process the stream for Responses API
    const reader = response.body;
    reader.on('data', (chunk: Buffer) => {
      logger.debug('Responses: Received chunk from Copilot', { length: chunk.length });
      parser.feed(chunk.toString());
    });

    reader.on('end', () => {
      logger.debug('Responses: Stream ended', { totalTextLength: accumulatedText.length });
      
      // Send completion events when stream ends (Copilot doesn't send [DONE])
      if (accumulatedText.length > 0 && !completionSent) {
        completionSent = true;
        // Send response.output_text.done
        res.write(`event: response.output_text.done\ndata: ${JSON.stringify({
          type: 'response.output_text.done',
          item_id: outputId,
          output_index: 0,
          content_index: 0,
          text: accumulatedText
        })}\n\n`);
        
        // Send response.output_item.done
        res.write(`event: response.output_item.done\ndata: ${JSON.stringify({
          type: 'response.output_item.done',
          item: {
            type: 'message',
            id: outputId,
            status: 'completed',
            role: 'assistant',
            content: [{ type: 'output_text', text: accumulatedText }]
          },
          output_index: 0
        })}\n\n`);
        
        // Send response.completed event
        res.write(`event: response.completed\ndata: ${JSON.stringify({
          type: 'response.completed',
          response: {
            id: responseId,
            object: 'response',
            created_at: Math.floor(Date.now() / 1000),
            model,
            status: 'completed',
            output: [{
              type: 'message',
              id: outputId,
              status: 'completed',
              role: 'assistant',
              content: [{ type: 'output_text', text: accumulatedText }]
            }]
          }
        })}\n\n`);
        
        // Send response.done (final event)
        res.write(`event: response.done\ndata: ${JSON.stringify({
          type: 'response.done',
          response: {
            id: responseId,
            object: 'response',
            created_at: Math.floor(Date.now() / 1000),
            model,
            status: 'completed',
            output: [{
              type: 'message',
              id: outputId,
              status: 'completed',
              role: 'assistant',
              content: [{ type: 'output_text', text: accumulatedText }]
            }]
          }
        })}\n\n`);
      }
      
      res.end();
    });

    reader.on('error', (err: Error) => {
      logger.error('SSE stream error:', err);
      res.write(`event: error\ndata: ${JSON.stringify({ 
        type: 'error',
        error: { message: String(err) } 
      })}\n\n`);
      res.end();
    });

  } catch (error) {
    logger.error('Error in streaming responses:', error);
    
    if (!res.headersSent) {
      return next(error);
    }
    
    try {
      res.write(`event: error\ndata: ${JSON.stringify({ 
        type: 'error',
        error: { message: String(error) } 
      })}\n\n`);
      res.end();
    } catch (streamError) {
      logger.error('Error sending error response to stream:', streamError);
    }
  }
}
