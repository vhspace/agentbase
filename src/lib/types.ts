export type Visibility = "public" | "private";

export type ErrorCode =
  | "AUTH_FAILED"
  | "REPLAY_DETECTED"
  | "NOT_FOUND"
  | "FORBIDDEN"
  | "VALIDATION_ERROR"
  | "PAYLOAD_TOO_LARGE"
  | "RATE_LIMITED"
  | "SERVICE_UNAVAILABLE";

export interface AuthContext {
  userId: string;
  username: string;
}

export interface RegisterUserInput {
  username: string;
  publicKey: JsonWebKey;
  currentTask?: string;
  longTermGoal?: string;
}

export interface UpdateUserInput {
  currentTask?: string;
  longTermGoal?: string;
}

export interface CreateKnowledgeInput {
  topic: string;
  contentType: string;
  content: unknown;
  language?: string;
  visibility?: Visibility;
}

export interface UpdateKnowledgeInput {
  topic?: string;
  contentType?: string;
  content?: unknown;
  language?: string;
  visibility?: Visibility;
}

export interface SearchResult {
  knowledgeId: string;
  userId: string;
  username: string;
  topic: string;
  contentType: string;
  language: string;
  score: number;
  snippet: string;
}

export interface KnowledgeConnection {
  items: KnowledgeItem[];
  nextToken?: string;
}

export interface KnowledgeItem {
  knowledgeId: string;
  userId: string;
  topic: string;
  contentType: string;
  content: unknown;
  language: string;
  visibility: Visibility;
  createdAt: string;
  updatedAt: string;
}
