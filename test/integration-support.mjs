const DEFAULT_STDERR_LIMIT = 8_192;

export function captureBoundedStderr(stream, limit = DEFAULT_STDERR_LIMIT) {
  let output = '';
  const onData = (chunk) => {
    output = `${output}${chunk.toString()}`;
    if (output.length > limit) {
      output = output.slice(-limit);
    }
  };

  stream?.on('data', onData);

  return {
    read: () => output,
    dispose: () => stream?.off('data', onData),
  };
}

export function formatErrorWithDiagnostics(error, stderr) {
  const message = error instanceof Error ? error.message : String(error);
  const diagnostics = stderr.trim() || '(no server stderr captured)';
  return new Error(`${message}\n\nServer stderr (bounded):\n${diagnostics}`, { cause: error });
}

export async function runWithCleanup(operation, cleanup) {
  let operationError;
  let cleanupError;
  let result;

  try {
    result = await operation();
  } catch (error) {
    operationError = error;
  }

  try {
    await cleanup();
  } catch (error) {
    cleanupError = error;
  }

  if (operationError instanceof Error) {
    if (cleanupError) {
      operationError.message += `\n\nCleanup failed: ${
        cleanupError instanceof Error ? cleanupError.message : String(cleanupError)
      }`;
    }
    throw operationError;
  }
  if (cleanupError) {
    throw cleanupError;
  }

  return result;
}

export async function retryIntegration(operation, { attempts = 2, delayMs = 1_000 } = {}) {
  let lastError;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await operation(attempt);
    } catch (error) {
      lastError = error;
      if (attempt < attempts) {
        await new Promise((resolve) => setTimeout(resolve, delayMs));
      }
    }
  }

  throw new Error(`Integration test failed after ${attempts} attempts`, { cause: lastError });
}
