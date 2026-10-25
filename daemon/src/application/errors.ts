/** Bad input to a use case. The CLI prints it; the API answers 400. */
export class ActionError extends Error {}

/** Turn a domain rule's message into an ActionError; a null message means the input is fine. */
export function refuse(message: string | null): void {
  if (message) throw new ActionError(message);
}
