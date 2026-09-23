export async function send(
  url: string,
  body: Uint8Array<ArrayBuffer>,
  headers: Record<string, string>,
  signal: AbortSignal,
): Promise<{
  status: number;
  body: number[];
  truncated: boolean;
  bodyFailed: boolean;
}> {
  const response = await fetch(url, {
    method: 'POST',
    body,
    headers,
    signal,
    redirect: 'manual',
  });
  const reader = response.body?.getReader();
  const bytes: number[] = [];
  let truncated = false;
  let bodyFailed = false;

  try {
    while (reader) {
      const chunk = await reader.read();

      if (chunk.done) {
        break;
      }

      const remaining = 4096 - bytes.length;

      bytes.push(...chunk.value.subarray(0, remaining));

      if (chunk.value.length > remaining) {
        truncated = true;

        break;
      }
    }
  } catch {
    bodyFailed = true;
  } finally {
    try {
      await reader?.cancel();
    } catch {
      bodyFailed = true;
    }
  }

  return { status: response.status, body: bytes, truncated, bodyFailed };
}
