/**
 * HTTP transport that reports results in the same shape as a child process.
 *
 * Every consumer of a provider call reads `{code, stdout, stderr, timedOut,
 * overflow, elapsedMs}`, so an HTTP-served provider produces that same record
 * instead of a second result shape the reporting and failure-handling code
 * would each have to learn.
 */

/**
 * Performs one bounded HTTP request and reports it as a command result.
 *
 * A non-success status is not an exception here: Ollama answers `{"error": ...}`
 * with a 4xx status, and that body is the most useful diagnostic available, so
 * it is preserved as output rather than discarded with the status code.
 *
 * @param {object} spec - Request spec with `url`, `method`, `headers`, and `body`.
 * @param {object} [options] - Transport options.
 * @param {number} [options.timeoutMs=300000] - Time before the request is aborted.
 * @param {number} [options.maxBytes=8388608] - Response body safety limit.
 * @param {Function} [options.fetchImpl=fetch] - Injectable fetch implementation.
 * @returns {Promise<object>} Exit code, output, timeout, overflow, PID, and timing.
 */
export async function httpRun(
  spec,
  { timeoutMs = 300000, maxBytes = 8 * 1024 * 1024, fetchImpl = fetch } = {},
) {
  const startedAt = Date.now();
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);

  const settle = (code, stdout, stderr, overflow = false) => ({
    code,
    stdout,
    stderr,
    timedOut,
    overflow,
    pid: null,
    elapsedMs: Date.now() - startedAt,
  });

  try {
    const response = await fetchImpl(spec.url, {
      method: spec.method ?? "POST",
      headers: spec.headers ?? {},
      body: spec.body,
      signal: controller.signal,
    });
    const { text, overflow } = await readBounded(response, maxBytes);
    const status = `HTTP ${response.status} ${response.statusText}`.trim();
    return settle(
      response.ok ? 0 : 1,
      text,
      response.ok ? "" : status,
      overflow,
    );
  } catch (error) {
    return settle(-1, "", String(error?.message ?? error));
  } finally {
    clearTimeout(timer);
  }
}

async function readBounded(response, maxBytes) {
  if (!response.body?.getReader) {
    const text = await response.text();
    const overflow = Buffer.byteLength(text) > maxBytes;
    return { text: overflow ? text.slice(0, maxBytes) : text, overflow };
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let text = "";
  let bytes = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    bytes += value.byteLength;
    text += decoder.decode(value, { stream: true });
    if (bytes > maxBytes) {
      await reader.cancel();
      return { text: text.slice(0, maxBytes), overflow: true };
    }
  }
  return { text: text + decoder.decode(), overflow: false };
}
