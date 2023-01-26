function syncMarianaTekToCalendar() {
  withScriptProperties(properties => {
    const failures = [];

    // Every day or so remove events that are older than 2 days, as
    // the size of Apps Script properties are limited.
    try {
      if (shouldCleanCache(properties)) {
        try {
          cleanCache(properties);
        } finally {
          markCacheCleaned();
        }
      }
    } catch (e) {
      failures.push(e.toString());
    }

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
      const propertyUpdates = {};
      for (const session of response.results) {
        try {
          const event = sessionToEvent(session);

          // Only import events if they are missing / different in cache.
          const cachedEvent = getCachedEvent(properties, event.iCalUid);
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
          setCachedEvent(properties, event);
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
  });
}

const EVENT_CACHE_PREFIX = 'Class ';
const LAST_CACHE_CLEAN = 'LAST_CACHE_CLEAN';

function shouldCleanCache(properties) {
  const lastCacheClean = properties[LAST_CACHE_CLEAN];
  if (lastCacheClean) {
    return parseDate(lastCacheClean).getTime() < getDaysAgo(1).getTime();
  }
  return null;
}

function cleanCache(properties) {
  const twoDaysAgo = getDaysAgo(2);

  for (const name of properties) {
    if (!name.startsWith(EVENT_CACHE_PREFIX)) {
      continue;
    }

    const event = JSON.parse(properties[name]);
    if (parseDate(event.start.dateTime).getTime() < twoDaysAgo.getTime()) {
      console.log(`Deleting "${name}" from cache.`);
      delete properties[name];
    }
  }
}

function markCacheCleaned(properties) {
  const now = new Date();
  properties.setProperty(LAST_CACHE_CLEAN, now.toISOString());
}

function getCachedEvent(properties, id) {
  const value = properties[EVENT_CACHE_PREFIX + id];
  if (value) {
    return JSON.parse(value);
  }
  return null;
}

function setCachedEvent(properties, event) {
  if (event) {
    properties[EVENT_CACHE_PREFIX + event.iCalUID] = event;
  } else {
    delete properties[EVENT_CACHE_PREFIX + event.iCalUID];
  }
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
