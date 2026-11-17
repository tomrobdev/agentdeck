// Errors: the body of every failed answer.

/** What a failed request answers with; `code` is there when the use case gave the error one. */
export interface ApiErrorBody {
  error: string;
  code?: string;
}
