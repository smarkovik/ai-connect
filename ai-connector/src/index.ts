import { prepareRequest, pipeStreamToWriter, handleRequest, SSE_HEADERS } from "./handler";

/**
 * Lambda Function URL handler with response streaming.
 *
 * Uses a two-phase approach:
 *   Phase 1 — prepareRequest: validates auth, config, model, and opens
 *             the Bedrock stream. No I/O to the response stream yet.
 *   Phase 2 — Based on the result, sets the correct response metadata
 *             (status code + headers) and either writes the error body
 *             or pipes SSE chunks in real-time.
 *
 * This ensures errors get proper HTTP status codes (401, 500, etc.)
 * instead of being hidden inside a 200 SSE stream.
 */
export const handler = awslambda.streamifyResponse(
  async (event: LambdaFunctionURLEvent, responseStream: ResponseStream) => {
    try {
      const method = event.requestContext?.http?.method || "GET";
      const path = event.rawPath || "/";
      const headers: Record<string, string | undefined> = {};

      // Normalize headers to lowercase
      if (event.headers) {
        for (const [key, value] of Object.entries(event.headers)) {
          headers[key.toLowerCase()] = value;
        }
      }

      const body = event.isBase64Encoded
        ? Buffer.from(event.body || "", "base64").toString("utf-8")
        : event.body || "";

      const configName = event.queryStringParameters?.config;

      // Phase 1: Validate and prepare — no response I/O yet
      const prepared = await prepareRequest({ method, path, headers, body, configName });

      if (!prepared.ok) {
        // Validation failed (auth, config, Bedrock error, CORS preflight)
        // Set the CORRECT error status code
        responseStream = awslambda.HttpResponseStream.from(responseStream, {
          statusCode: prepared.response.statusCode,
          headers: prepared.response.headers || {},
        });
        // Always write something so HttpResponseStream flushes headers
        // (empty streaming responses may not send metadata to the client)
        responseStream.write(prepared.response.body || "");
      } else if (prepared.isStreaming) {
        // Phase 2: Pipe Bedrock SSE chunks to client in real-time
        responseStream = awslambda.HttpResponseStream.from(responseStream, {
          statusCode: 200,
          headers: SSE_HEADERS,
        });
        await pipeStreamToWriter(prepared.stream, prepared.modelId, responseStream);
      } else {
        // Non-streaming: buffer the full Bedrock response as JSON
        // (falls back to handleRequest which buffers internally)
        const result = await handleRequest({ method, path, headers, body, configName });

        responseStream = awslambda.HttpResponseStream.from(responseStream, {
          statusCode: result.statusCode,
          headers: result.headers || {},
        });
        if (result.body) {
          responseStream.write(result.body);
        }
      }
    } catch (err) {
      // Catch-all for unexpected errors at the streaming wrapper level
      const message = err instanceof Error ? err.message : "Internal server error";
      const errorBody = JSON.stringify({
        error: { message, type: "server_error", code: "500" },
      });

      responseStream = awslambda.HttpResponseStream.from(responseStream, {
        statusCode: 500,
        headers: { "Content-Type": "application/json" },
      });

      responseStream.write(errorBody);
    } finally {
      responseStream.end();
    }
  }
);

// Type declarations for Lambda Function URL streaming runtime
declare namespace awslambda {
  function streamifyResponse(
    handler: (
      event: LambdaFunctionURLEvent,
      responseStream: ResponseStream
    ) => Promise<void>
  ): (event: LambdaFunctionURLEvent) => Promise<void>;

  namespace HttpResponseStream {
    function from(
      stream: ResponseStream,
      metadata: { statusCode: number; headers: Record<string, string> }
    ): ResponseStream;
  }
}

interface ResponseStream {
  write(data: string | Buffer): void;
  end(): void;
}

interface LambdaFunctionURLEvent {
  requestContext?: {
    http?: {
      method: string;
      path: string;
    };
  };
  rawPath?: string;
  queryStringParameters?: Record<string, string>;
  headers?: Record<string, string>;
  body?: string;
  isBase64Encoded?: boolean;
}
