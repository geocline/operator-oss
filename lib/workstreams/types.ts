export type WorkstreamState = "active" | "paused" | "disconnected";

export type WorkstreamOutboxState =
  | "pending"
  | "delivering"
  | "delivered"
  | "failed";

export type WorkstreamEventType =
  | "routine_update"
  | "proposed_change"
  | "conversation_registration";

export type WorkstreamEventPayload = Record<string, unknown>;

export interface WorkstreamLink {
  id: string;
  task_id: string;
  provider: string;
  external_card_id: string;
  external_workstream_id: string;
  state: WorkstreamState;
  created_at: number;
  updated_at: number;
}

export interface WorkstreamOutboxEvent {
  id: string;
  link_id: string;
  idempotency_key: string;
  event_type: WorkstreamEventType;
  payload: WorkstreamEventPayload;
  state: WorkstreamOutboxState;
  attempts: number;
  next_attempt_at: number;
  claim_expires_at: number;
  claim_token: string;
  last_error: string;
  delivered_at: number;
  created_at: number;
  updated_at: number;
}

export interface ActivateWorkstreamInput {
  taskId: string;
  provider: string;
  externalCardId: string;
  externalWorkstreamId: string;
  initialState?: Exclude<WorkstreamState, "disconnected">;
}

export interface EnqueueWorkstreamEventInput {
  linkId: string;
  idempotencyKey: string;
  eventType: WorkstreamEventType;
  payload: WorkstreamEventPayload;
  nextAttemptAt?: number;
}

export type CardFacingViolationCode =
  | "invalid_value"
  | "local_path"
  | "file_url"
  | "internal_url"
  | "temp_outputs"
  | "internal_term"
  | "internal_name"
  | "internal_identifier"
  | "unsupported_file_type";

export interface CardFacingViolation {
  field: string;
  code: CardFacingViolationCode;
  message: string;
}

export interface CardFacingValidation {
  ok: boolean;
  violations: CardFacingViolation[];
}
