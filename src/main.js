function runWithoutCache() {
  run({ withoutCache: true});
}

function clearCalendars() {
  run({ withoutCache: true, clearEvents: true });
}

function syncAllSourcesToCalendars(config, options) {
  if (!options) {
    options = {};
  }
  Diagnostics.withErrorAggregation('Sync to Calendars', diagnostics => {
    // Shuffle sources so that if one uses up all the time, the others still
    // eventually make progress.
    for (const source of shuffled(config.sources)) {
      if (options['clearEvents']) {
        diagnostics.withErrorRecording(`Clearing source "${source.name}"`, () => {
          for (const calendar of source.getAllTargetCalendars()) {
            diagnostics.withErrorRecording(`Clearing calendar "${calendar}"`, () => {
              clearEventsInCalendar(diagnostics, config, source, calendar);
            });
          }
        });
      } else {
        diagnostics.withErrorRecording(`Syncing source "${source.name}"`, () => {
          syncSourceToCalendars(diagnostics, options, source);
        });
      }
    }
  });
}

function clearEventsInCalendar(diagnostics, config, source, calendar) {
  let keepGoing = true;
  while (keepGoing) {
    keepGoing = false;
    const listResponse = Calendar.Events.list(calendar, {
      timeMin: getDaysAgo(source.pastDaysToFetch).toISOString()
    });
    for (const event of listResponse.items) {
      if (event.iCalUID.startsWith(source.idPrefix)) {
        diagnostics.withErrorRecording(`Deleting ${event.summary}`, () => {
          Calendar.Events.remove(calendar, event.id);
          // Deleted something so there may be more to do.
          keepGoing = true;
        });
      }
    }
  }
}

function syncSourceToCalendars(diagnostics, options, source) {
  let fetchNumber = 0;
  while (true) {
    fetchNumber += 1;

    const response = source.fetchPage(diagnostics, fetchNumber);
    console.log(`Fetched ${response.results.length} events from "${source.name}"`);

    for (const fetchResult of response.results) {
      syncEventToCalendar(diagnostics, options, source, fetchResult);
    }

    console.log(`Cumulative Errors: ${diagnostics.getErrorCount()}`);
    console.log(`Cumulative Syncs: ${syncNumber}`);
    console.log(`Cumulative Cancellations: ${cancelNumber}`);
    console.log(`Cumulative Skipped (cached): ${cachedNumber}`);
    if (!response.keepGoing) {
      break;
    }
  }
}

let syncNumber = 0;
let cancelNumber = 0;
let cachedNumber = 0;

function syncEventToCalendar(diagnostics, options, source, fetchResult) {
  const id = fetchResult.id;
  const processingMessage =
        `Processing "${fetchResult.name}" event with ID ${id} at ${fetchResult.start_datetime}`;
  diagnostics.withErrorRecording(processingMessage, () => {
    const event = source.makeEvent(fetchResult);
    for (const targetCalendar of source.getTargetCalendarsForFetchResult(fetchResult)) {
      // Only import events if they are missing or different in cache.
      if (!options['withoutCache'] && checkEventAlreadySynced(targetCalendar, event)) {
        cachedNumber += 1;
        return;
      }

      if (event.status === 'cancelled') {
        cancelNumber += 1;
      } else {
        syncNumber += 1;
      }
      diagnostics.withErrorRecording(null, () => {
        diagnostics.withRateLimitingRetry(`Sync to calendar (#${syncNumber})`, 10, () => {
          Calendar.Events.import(event, targetCalendar);
        });
        markEventSynced(targetCalendar, event);
      });
    }
  });
}

const SCRIPT_CACHE = CacheService.getScriptCache();

const EVENT_CACHE_PREFIX = 'event_';
const CACHE_TTL = 60 * 60 * 2; // two hours

/**
 * Returns true if the event matches the cached event, indicating it
 * has already been synced to the calendar. This checks that the data
 * is the same as well, to support changes to the event generation
 * logic or configuration.
 */
function checkEventAlreadySynced(targetCalendar, event) {
  // FIXME: include target calendar id in cache key
  const cachedEvent = SCRIPT_CACHE.get(getCacheKey(targetCalendar, event));
  // JSON serialization is used for deep equality, which may
  // not work if attribute order differs. Thankfully here it
  // does not differ.
  return cachedEvent && cachedEvent == JSON.stringify(event);
}

function markEventSynced(targetCalendar, event) {
  const key = getCacheKey(targetCalendar, event);
  const value = JSON.stringify(event);
  SCRIPT_CACHE.put(key, value, CACHE_TTL);
}

function getCacheKey(targetCalendar, event) {
  return `event ${event.iCalUID} for ${targetCalendar}`;
}
