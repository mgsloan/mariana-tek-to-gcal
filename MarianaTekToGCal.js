const BRAND = 'BRAND_HERE';
const INCLUDE_RESERVE_LINK = true;
const INCLUDE_PHONE_NUMBER = false;
const INCLUDE_EMAIL = true;
const INCLUDE_ADDRESS = true;
const LOCATION_MODE = 'concise';
const CUSTOM_PREFIX = "";
const CUSTOM_SUFFIX = "";

const DAYS_TO_FETCH = 30;

const DEFAULT_TARGET_CALENDAR = 'primary';

const LOCATION_TO_TARGET_CALENDAR = {
  'Calendar name': 'some-calendar@gmail.com',
};

function syncMarianaTekToCalendar() {
  const fetchUpperBound = getDaysAgo(-DAYS_TO_FETCH);
  Diagnostics.withErrorAggregation('Sync from MarianaTek to Calendar', diagnostics => {
    diagnostics.setLogErrors(true);
    const fetcher = new MarianaTekFetcher(BRAND, /* startDate= */ getDaysAgo(1));
    let fetchNumber = 0;
    while (true) {
      fetchNumber += 1;
      const response = diagnostics.withRateLimitingRetry('Fetch (#${fetchNumber})', () => fetcher.fetchPage());

      if (response === null) {
        return;
      }

      for (const session of response.results) {
        syncSingleSessionToCalendar(diagnostics, session);
      }

      const sessionTimes = response.results.map(session => parseDate(session.start_datetime).getTime());
      const lastSessionEpochMillis = Math.max(...sessionTimes);
      console.log(`Fetched up to ${new Date(lastSessionEpochMillis)}`);
      console.log(`Errors: ${diagnostics.getErrorCount()}`);
      console.log(`New Imports: ${importNumber}`);
      console.log(`New Cancellations: ${cancelNumber}`);
      if (lastSessionEpochMillis > fetchUpperBound.getTime()) {
        return;
      }
    }
  });
}

let importNumber = 0;
let cancelNumber = 0;

function syncSingleSessionToCalendar(diagnostics, session) {
  const id = session.id;
  diagnostics.withErrorRecording(`Processing "${session.name}" class with ID ${id}`, () => {
    const event = sessionToEvent(session);

    // Only import events if they are missing / different in cache.
    const cachedEvent = getCachedEvent(event.iCalUid);
    if (event == cachedEvent) {
      return;
    }

    const targetCalendar = getTargetCalendarForSession(session);
    if (targetCalendar) {
      if (event.status === 'cancelled') {
        cancelNumber += 1;
        diagnostics.withErrorRecording(null, () => {
          diagnostics.withRateLimitingRetry(`Cancel calendar event (#${cancelNumber})`, () => {
            Calendar.Events.remove(targetCalendar, event.id);
          });
        });
      } else {
        importNumber += 1;
        diagnostics.withErrorRecording(null, () => {
          diagnostics.withRateLimitingRetry(`Import to calendar (#${importNumber})`, () => {
            Calendar.Events.import(event, targetCalendar);
          });
        });
      }
      // Update cache after delete or import, so that if it fails it
      // will be retried.
      setCachedEvent(event);
    } else {
      // FIXME: warning / info?
    }
  });
}

function getTargetCalendarForSession(session) {
  let targetCalendar;
  if (LOCATION_TO_TARGET_CALENDAR) {
    const location = session.location?.name;
    if (!location) {
      throw new Error('No location name to determine target calendar.');
    }
    targetCalendar = LOCATION_TO_TARGET_CALENDAR[location];
    if (!targetCalendar) {
      throw new Error(`No target calendar for location "${location}"`);
    }
  } else if (DEFAULT_TARGET_CALENDAR) {
    targetCalendar = DEFAULT_TARGET_CALENDAR;
  } else {
    // TODO: error type that does full abort?
    throw new Error('Invalid target calendar configuration.');
  }
}

const SCRIPT_CACHE = CacheService.getScriptCache();

const EVENT_CACHE_PREFIX = 'Class ';
const CACHE_TTL = 60 * 60 * 2; // two hours

function getCachedEvent(id) {
  const value = SCRIPT_CACHE.get(EVENT_CACHE_PREFIX + id);
  if (value) {
    return JSON.parse(value);
  }
  return null;
}

function setCachedEvent(event) {
  const key = EVENT_CACHE_PREFIX + event.iCalUID;
  const value = JSON.stringify(event);
  SCRIPT_CACHE.put(key, value, CACHE_TTL);
}

function sessionToEvent(session) {
  if (session.is_cancelled) {
    return { status: 'cancelled', id: session.id };
  }

  let summary = session.name;

  const names = session.instructors.map(x => x.name.trim()).filter(x => x);
  const firstNames = names.map(x => x.split(' ')[0]);
  if (names) {
    summary += ` with ${toNaturalList(firstNames)}`;
  }

  const oneLineAddress = session.location?.formatted_address?.join(', ');

  let description = CUSTOM_PREFIX;
  description += `${session.name} class with ${toNaturalList(names)}\n\n`;
  if (INCLUDE_RESERVE_LINK) {
    description += `<a href="https://${BRAND}.marianaiframes.com/iframe/classes/${session.id}/reserve">Reserve</a>\n\n`
  }
  if (INCLUDE_ADDRESS && oneLineAddress) {
    const mapsUrl = "https://www.google.com/maps/place/" + encodeURIComponent(oneLineAddress);
    // FIXME: sanitize
    description += `<a href="${mapsUrl}">${oneLineAddress}</a>\n\n`
  }
  if (INCLUDE_PHONE_NUMBER && session.location.phone_number) {
    description += session.location.phone_number + '\n';
  }
  if (INCLUDE_EMAIL && session.location.email) {
    description += session.location.email;
  }
  description += CUSTOM_SUFFIX;

  const startDateTime = parseDate(session.start_datetime);
  const durationMillis = session.class_type.duration * 60 * 1000;
  const endDateTime = new Date(startDateTime.getTime() + durationMillis);

  const result = {
    status: 'confirmed',
    iCalUID: session.id,
    summary: summary,
    description: description,
    start: {
      dateTime: startDateTime.toISOString(),
    },
    end: {
      dateTime: endDateTime.toISOString(),
    },
  };

  switch (LOCATION_MODE) {
    case 'full':
      if (oneLineAddress) {
        result.location = oneLineAddress;
      }
      break;
    case 'concise':
      const firstLine = session.location?.formatted_address[0];
      const city = session.location?.city;
      const state_province = session.location?.state_province;
      if (firstLine && city) {
        result.location = `${firstLine}, ${city} ${state_province}`;
      } else {
        // TODO: warning
      }
      break;
    case 'none':
      break;
    default:
      // TODO: warning instead.
      throw new Error(`Unrecognized LOCATION_MODE "${LOCATION_MODE}"`);
  }

  return result;
}

function toNaturalList(things) {
  if (things.length === 1) {
    return things[0];
  } else if (things.length === 2) {
    return `${things[0]} and ${things[1]}`;
  } else {
    let result = '';
    for (let i = 0; i < things.length; i++) {
      result += things[i];
      if (i == things.length - 1) {
        result += ', and ';
      } else {
        result += ', ';
      }
    }
    return result;
  }
}

function getDaysAgo(days) {
  const yesterday = new Date();
  yesterday.setTime(yesterday.getTime() - 24*60*60*1000*days);
  return yesterday;
}

function parseDate(dateString) {
  const result = Date.parse(dateString)
  if (!result) {
    throw Error(`Failed to parse date "${dateString}"`);
  }
  return new Date(result);
}

function toUtcDateString(datetime) {
  return datetime.getUTCFullYear().toString() + '-' +
    (datetime.getUTCMonth() + 1).toString().padStart(2, '0') + '-' +
    datetime.getUTCDate().toString().padStart(2, '0');
}


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

class MarianaTekFetcher {
  constructor(brand, startDate) {
    this.brand = brand;
    const dateString = toUtcDateString(startDate);
    this.url =
      `https://${BRAND}.marianatek.com/api/customer/v1/classes?min_start_date=${dateString}`;
  }

  fetchPage() {
    if (!this.url) {
      return null;
    }
    const rawResponse = UrlFetchApp.fetch(this.url, { headers: {'ACCEPT': 'application/json'}});
    const responseCode = rawResponse.getResponseCode();
    if (responseCode !== 200) {
      throw new Error(`MarianaTek responded with ${rawResponse.getResponseCode()}:\n${rawResponse.getContentText()}`);
    }
    const response = JSON.parse(rawResponse.getContentText());
    this.url = response.links?.next;
    return response;
  }
}

