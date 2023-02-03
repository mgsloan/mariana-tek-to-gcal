
/**
 * The purpose of this class is to make it easy to have script
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
    instance.__exited = false;
    return instance.withContext(contextString, () => {
      try {
        return f(instance);
      } catch (e) {
        instance.reportError(e);
      } finally {
        if (instance.__errors.length > 0) {
          throw new Error(instance.__makeAggregateErrorMessage());
        }
        instance.__exited = true;
      }
    });
  }

  /**
   * Setting this to true will cause failures to also be immediately
   * logged. This is helpful during development.
   */
  setLogErrors(logErrors) {
    this.__logErrors = logErrors;
  }

  /** Add an error to the list. */
  reportError(message) {
    if (typeof message !== 'string') {
      message = message.stack || message.toString();
    }
    const error = {
      context: [...this.__contexts],
      message: message,
    };
    if (this.__logErrors) {
      console.error(message);
    }
    this.__errors.push(error);
  }

  /**
   * Runs the provided function within a named context. If an error is thrown it is recorded, and execution continues.
   */
  withErrorRecording(contextString, f) {
    return this.withContext(contextString, () => {
      try {
        return f();
      } catch (e) {
        this.reportError(e);
      }
      return null;
    });
  }

  /**
   */
  withRateLimitingRetry(contextString, f) {
    return this.withContext(contextString, () => {
      let retryCount = 0;
      while (true) {
        try {
          return f();
        } catch (e) {
          if (e.toString().includes('Rate Limit Exceeded')) {
            Utilities.sleep(1000);
            retryCount += 1;
            console.log(`Retry #${retryCount} for ${contextString} slept for 1 second due to Rate Limiting.`);
          } else {
            throw e
          }
        }
      };
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

  getErrorCount() {
    return this.__errors.length;
  }

  __internalError(message) {
    this.logError(`Internal error in Diagnostics: ${message}`);
  }

  __makeAggregateErrorMessage() {
    let lastContext = [];
    let result = '\n\n';
    for (const error of this.__errors) {
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
        result += ' '.repeat(i * 4) + context[i] + '\n';
      }
      // Add message
      result += ' '.repeat(i * 4) + error.message + '\n\n';
      lastContext = context;
    }
    return result;
  }
}
