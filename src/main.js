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
