export interface OpenAIMessage {
  role: 'system' | 'user' | 'assistant' | 'function';
  content: string | null;
  name?: string;
  function_call?: {
    name: string;
    arguments: string;
  };
}

export interface OpenAICompletionRequest {
  model: string;
  messages: OpenAIMessage[];
  temperature?: number;
  top_p?: number;
  n?: number;
  stream?: boolean;
  stop?: string | string[];
  max_tokens?: number;
  presence_penalty?: number;
  frequency_penalty?: number;
  logit_bias?: Record<string, number>;
  user?: string;
  functions?: any[];
  function_call?: 'auto' | 'none' | { name: string };
}

export interface OpenAICompletionChoice {
  index: number;
  message?: OpenAIMessage;
  delta?: Partial<OpenAIMessage>;
  finish_reason: string | null;
}

export interface OpenAICompletion {
  id: string;
  object: string;
  created: number;
  model: string;
  choices: OpenAICompletionChoice[];
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
}

export interface OpenAIModel {
  id: string;
  object: string;
  created: number;
  owned_by: string;
}

export interface OpenAIModelList {
  object: string;
  data: OpenAIModel[];
}

// OpenAI Responses API Types
export interface ResponsesInput {
  type?: 'message';  // Optional - OpenAI-style messages may not have this
  role: 'user' | 'assistant' | 'system' | 'developer';
  content: string | ResponsesContentPart[];
}

export interface ResponsesContentPart {
  type: 'input_text' | 'output_text' | 'text';
  text: string;
}

export interface ResponsesRequest {
  model: string;
  input: string | ResponsesInput[];
  instructions?: string;
  temperature?: number;
  max_output_tokens?: number;
  top_p?: number;
  stream?: boolean;
  tools?: any[];
  tool_choice?: string | { type: string; name: string };
  metadata?: Record<string, string>;
  store?: boolean;
  previous_response_id?: string;
}

export interface ResponsesOutput {
  type: 'message';
  id: string;
  status: 'completed' | 'in_progress' | 'incomplete';
  role: 'assistant';
  content: ResponsesContentPart[];
}

export interface ResponsesResponse {
  id: string;
  object: 'response';
  created_at: number;
  model: string;
  status: 'completed' | 'in_progress' | 'incomplete' | 'failed';
  output: ResponsesOutput[];
  usage?: {
    input_tokens: number;
    output_tokens: number;
    total_tokens: number;
  };
  metadata?: Record<string, string>;
  error?: {
    code: string;
    message: string;
  };
}
