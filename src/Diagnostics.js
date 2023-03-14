const scriptStartTime = new Date();

/**
 * The purpose of this class is to make it easy to have Apps Script
 * execution carry on despite errors, and report these errors with a
 * comprehensible structure.
 */
class Diagnostics {
  /**
   * Runs the provided function, and passes it an instance of this
   * class. At the end of execution, if any errors were recorded then
   * they will be reported in a single error that concatenates their
   * messages.
   *
   * Usage of the instance of this class after this returns is invalid
   * and will throw an error.
   */
  static withErrorAggregation(contextString, f) {
    const instance = new Diagnostics;
    instance.__errors = [];
    instance.__contexts = [];
    instance.__logErrors = false;
    // Attempt to exit more informatively by limiting execution time
    // to 10 seconds less than the 6 minute limit.
    instance.__executionTimeLimitMillis = (60 * 6 - 10) * 1000;
    instance.__exited = false;
    return instance.withContext(contextString, () => {
      let mainErrorWasTimeLimitExceeded = false;
      try {
        try {
          return f(instance);
        } catch (e) {
          mainErrorWasTimeLimitExceeded = e instanceof ScriptExecutionTimeLimitExceeded;
          instance.reportError(e);
        }
      } finally {
        if (instance.__errors.length === 1 && mainErrorWasTimeLimitExceeded) {
          throw new ScriptExecutionTimeLimitExceeded();
        } else if (instance.__errors.length > 0) {
          throw new MultiError(instance.__errors);
        }
        instance.__exited = true;
      }
    });
  }

  /**
   * Set this to true to cause failures to also be immediately logged.
   * This is particularly helpful during development.
   */
  setLogErrors(logErrors) {
    this.__logErrors = logErrors;
  }

  /**
   * Set this to some value less than the Apps Script execution time
   * limit (typically 6 minutes). Set to null to disable time limit
   * checking.
   */
  setExecutionTimeLimitMillis(millis) {
    this.__executionTimeLimitMillis = millis;
  }

  /** Get current count of recorded errors. */
  getErrorCount() {
    return this.__errors.length;
  }

  /** Add an error to the list. */
  reportError(message) {
    if (typeof message !== 'string') {
      message = message.stack
        || (message.toString && message.toString())
        || message;
    }
    const error = {
      context: [...this.__contexts],
      message: message,
    };
    if (this.__logErrors) {
      console.error(message);
    }
    this.__errors.push(error);
    this.checkScriptTimeLimit();
  }

  /**
   * Runs the provided function within a named context. If an error is
   * thrown it is recorded, and execution continues.
   */
  withErrorRecording(contextString, f) {
    return this.withContext(contextString, () => {
      try {
        this.checkScriptTimeLimit();
        return f();
      } catch (e) {
        if (e instanceof ScriptExecutionTimeLimitExceeded) {
          throw e;
        }
        this.reportError(e);
      }
      return null;
    });
  }

  /**
   * Runs the provided function and retries it after sleeping 2 seconds
   * if it throws an error that looks like Apps Script rate limiting.
   * Retry count is limited to the number passed to 'retryLimit'.
   */
  withRateLimitingRetry(contextString, retryLimit, f) {
    return this.withRetry(
        contextString,
        retryLimit,
        (e) => e.toString().includes('Rate Limit Exceeded'),
        f
    );
  }

 /**
  * Runs the provided function and retries it after sleeping 2 seconds
  * if it throws an error that matches the provided predicate. Retry
  * count is limited to the number passed to 'retryLimit'.
  */
  withRetry(contextString, retryLimit, shouldRetry, f) {
    return this.withContext(contextString, () => {
      let retryCount = 0;
      while (retryCount < retryLimit) {
        this.checkScriptTimeLimit();
        try {
          return f();
        } catch (e) {
          if (shouldRetry(e)) {
            Utilities.sleep(2000);
            retryCount += 1;
            console.log(`Retry #${retryCount} for ${contextString} slept for 2 seconds due to Rate Limiting.`);
          } else {
            throw e;
          }
        }
      };
      throw new Error(`Failed #${retryLimit} retries of ${contextString}.`);
    });
  }

  /**
   * Runs the provided function within a named context. Does not catch errors.
   */
  // TODO: decorate exceptions
  withContext(contextString, f) {
    if (contextString) {
      this.__contexts.push(contextString);
    }
    let result = null;
    try {
      result = f();
      this.checkScriptTimeLimit();
    } finally {
      if (contextString) {
        const poppedContextString = this.__contexts.pop();
        if (poppedContextString !== contextString) {
            this.__internalError('popped context string did not match pushed.');
        }
      }
    }
    return result;
  }

  /**
   * Check whether the script is near the time limit, and throw an
   * error if so. This function is invoked by most other methods in
   * this class, so you may not need to manually call this.
   */
  checkScriptTimeLimit() {
    if (this.__executionTimeLimitMillis === null) {
      return;
    }
    if (new Date() - scriptStartTime > this.__executionTimeLimitMillis) {
      throw new ScriptExecutionTimeLimitExceeded();
    }
  }

  __internalError(message) {
    this.logError(`Internal error in Diagnostics: ${message}`);
  }
}

class MultiError extends Error {
  constructor(errors) {
    let lastContext = [];
    let message = '\n\n';
    for (const error of errors) {
      const context = error.context;
      let i = 0;
      // Find common prefix
      for (; i < lastContext.length && i < context.length; i++) {
        if (lastContext[i] !== context[i]) {
          break;
        }
      }
      // Add remaining contexts
      for (; i < context.length; i++) {
        message += ' '.repeat(i * 4) + context[i] + '\n';
      }
      // Add message
      message += ' '.repeat(i * 4) + error.message + '\n\n';
      lastContext = context;
    }
    super(message);
    this.errors = errors;
  }
}

class ScriptExecutionTimeLimitExceeded extends Error {
  constructor() {
    super("Script execution time limit exceeded.");
  }
}
