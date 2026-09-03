/**
 * Keeps database driver objects out of structured logs: those objects may
 * contain SQL text, bound values, and database details. The trace id links the
 * client response to the protected infrastructure logs when deeper diagnosis
 * is required.
 */
export function exceptionLogContext(exception: unknown): {
  readonly type: string;
  readonly code?: string;
} {
  if (!(exception instanceof Error)) {
    return { type: typeof exception };
  }

  const code = (exception as Error & { code?: unknown }).code;
  return {
    type: exception.name,
    ...(typeof code === 'string' && /^[A-Za-z0-9_.-]{1,64}$/.test(code) ? { code } : {}),
  };
}
