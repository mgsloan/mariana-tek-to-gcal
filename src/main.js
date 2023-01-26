function syncMarianaTekToCalendar() {
  const failures = [];

  // Start fetch a day ago to avoid any fiddly race conditions / time zone stuff.
  const fetchMinTime = getDaysAgo(1);

  // Build class list request URL
  const yesterdayDate = toUtcDateString(fetchMinTime);
  let url = `https://${BRAND}.marianatek.com/api/customer/v1/classes?min_start_date=${yesterdayDate}`;

  let fetchNumber = 1;
  let moreToFetch = true;
  while (moreToFetch) {
    console.log(`Fetch #${fetchNumber} to ${url}`);

    // Request class list
    const rawResponse = UrlFetchApp.fetch(url, headers={'ACCEPT': 'application/json'});
    const responseCode = rawResponse.getResponseCode();
    if (responseCode !== 200) {
      failures.push(`MarianaTek responded with ${rawResponse.getResponseCode()}:\n${rawResponse.getContentText()}`);
      throw new Error(failures.join('\n'));
    }
    const response = JSON.parse(rawResponse.getContentText());

    // console.log(response.results[0]);

    // Import classes into calendar
    for (const session of response.results) {
      try {
        const event = sessionToEvent(session);

        // Only import events if they are missing / different in cache.
        const cachedEvent = getCachedEvent(event.iCalUid);
        if (event == cachedEvent) {
          continue;
        }

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
        } else {
          targetCalendar = DEFAULT_TARGET_CALENDAR;
        }

        Calendar.Events.import(event, targetCalendar);

        // Update cache after import, so that if it fails it will be retried.
        setCachedEvent(event);
      } catch (e) {
        failures.push(`When importing class ${session.name} with ID ${session.id}:\n${e.toString()}`);
      }
    }

    const lastSessionEpochMillis = Math.max(...response.results.map(session => parseDate(session.start_datetime).getTime()));
    console.log(`Fetched up to ${new Date(lastSessionEpochMillis)}`);
    moreToFetch =
      url != response.links.last &&
      response.links.next &&
      lastSessionEpochMillis < getDaysAgo(-DAYS_TO_FETCH).getTime();

    fetchNumber += 1;
    url = response.links.next;
  }

  if (failures.length) {
    throw new Error(failures.join('\n\n'));
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
