const CONCISE_LOCATION = 'concise';
const FULL_LOCATION = 'full';
const NO_LOCATION = 'none';

class MarianaTek {
  constructor(config) {
    // Try to fail promptly and descriptively on configuration errors.
    //
    // TODO: also check that required fields are present.
    const configString = JSON.stringify(config, null, 2);
    for (const field in config) {
      const value = config[field];
      switch (field) {
      case 'name':
      case 'idPrefix':
      case 'brand':
      case 'customPrefix':
      case 'customSuffix':
      case 'targetCalendar':
        assert(typeof value === 'string', `'${field}' field not a string in:\n${configString}`);
        break;
      case 'locationMode':
        assert(
          value === CONCISE_LOCATION || value === FULL_LOCATION || value === NO_LOCATION,
          `Unrecognized value for '${field}' in:\n${configString}`);
        break;
      case 'pastDaysToFetch':
      case 'futureDaysToFetch':
        assert(typeof value === 'number', `'${field}' field not a number in:\n${configString}`);
        break;
      case 'includeReserveLink':
      case 'includePhoneNumber':
      case 'includeEmail':
      case 'includeAddress':
        assert(typeof value === 'boolean', `'${field}' field not a boolean in:\n${configString}`);
        break;
      case 'locationToTargetCalendars':
        assert(typeof value === 'object', `'${field}' field not an object in:\n${configString}`);
        for (const location in value) {
          const targets = value[location];
          assert(typeof targets === 'object' && targets.entries, `locationToTargetCalendars['${location}'] not an array in:\n${configString}`);
          for (const [i, target] of targets.entries()) {
            assert(typeof target === 'string', `locationToTargetCalendars['${location}'][${i}] not a string in:\n${configString}`);
          }
        }
        break;
      default:
        throw new Error(`Unrecognized field '${field}' in:\n${configString}'`);
      }
    }

    assert(
      ('targetCalendar' in config) !== ('locationToTargetCalendars' in config),
      `Either 'targetCalendar' or 'locationToTargetCalendars' must be specified, but not both, in config:\n${configString}`);

    Object.assign(this, config);

    const dateString = toUtcDateString(getDaysAgo(config.pastDaysToFetch));
    this.url =
      `https://${this.brand}.marianatek.com/api/customer/v1/classes?min_start_date=${dateString}`;
    this.fetchUpperBound = getDaysAgo(-config.futureDaysToFetch);
  }

  fetchPage(diagnostics, fetchNumber) {
    const response = diagnostics.withRetry(
      `Fetch #${fetchNumber} for ${this.name}`,
      10,
      (e) => e.toString().includes('Address unavailable'),
      () => {
        const rawResponse = UrlFetchApp.fetch(this.url, { headers: {'ACCEPT': 'application/json'}});
        const responseCode = rawResponse.getResponseCode();
        if (responseCode !== 200) {
          throw new Error(`MarianaTek responded with ${rawResponse.getResponseCode()}:\n${rawResponse.getContentText()}`);
        }
        const response = JSON.parse(rawResponse.getContentText());
        return response;
      });

    if (!response || response.results.length === 0) {
      return {
        results: [],
        keepGoing: false,
      };
    }

    this.url = response.links?.next;

    const sessionTimes = response.results.map(session => parseDate(session.start_datetime).getTime());
    const lastSessionEpochMillis = Math.max(...sessionTimes);
    console.log(`Fetched up to ${new Date(lastSessionEpochMillis)}`);

    const fetchUpperBoundMillis = this.fetchUpperBound.getTime();
    return {
      results: response.results,
      keepGoing: this.url !== null && lastSessionEpochMillis < fetchUpperBoundMillis,
    };
  }

  getTargetCalendars(fetchResult) {
    if (this.locationToTargetCalendars) {
      const location = fetchResult.location?.name;
      if (!location) {
        throw new Error('No location name to determine target calendars.');
      }
      const targetCalendars = this.locationToTargetCalendars[location];
      if (!targetCalendars) {
        throw new Error(`No target calendars for location "${location}"`);
      }
      return targetCalendars;
    } else if (this.targetCalendar) {
      return [this.targetCalendar];
    } else {
      throw new Error('Invalid target calendar configuration.');
    }
  }

  makeEvent(fetchResult) {
    if (fetchResult.is_cancelled) {
      return { status: 'cancelled', id: fetchResult.id };
    }

    let summary = fetchResult.name;

    const names = fetchResult.instructors.map(x => x.name.trim()).filter(x => x);
    const firstNames = names.map(x => x.split(' ')[0]);
    if (names) {
      summary += ` with ${toNaturalList(firstNames)}`;
    }

    const oneLineAddress = fetchResult.location?.formatted_address?.join(', ');

    let description = this.customPrefix || '';
    description += `${fetchResult.name} class with ${toNaturalList(names)}\n\n`;
    if (this.includeReserveLink) {
      description += `<a href="https://${this.brand}.marianaiframes.com/iframe/classes/${fetchResult.id}/reserve">Reserve</a>\n\n`
    }
    if (this.includeAddress && oneLineAddress) {
      const mapsUrl = 'https://www.google.com/maps/place/' + encodeURIComponent(oneLineAddress);
      // FIXME: sanitize
      description += `<a href="${mapsUrl}">${oneLineAddress}</a>\n\n`
    }
    if (this.includePhoneNumber && fetchResult.location.phone_number) {
      description += fetchResult.location.phone_number + '\n';
    }
    if (this.includeEmail && fetchResult.location.email) {
      description += fetchResult.location.email;
    }
    description += this.customSuffix || '';

    const startDateTime = parseDate(fetchResult.start_datetime);
    const durationMillis = fetchResult.class_type.duration * 60 * 1000;
    const endDateTime = new Date(startDateTime.getTime() + durationMillis);

    const event = {
      status: 'confirmed',
      iCalUID: fetchResult.id,
      summary: summary,
      description: description,
      start: {
        dateTime: startDateTime.toISOString(),
      },
      end: {
        dateTime: endDateTime.toISOString(),
      },
    };

    if (this.locationMode === FULL_LOCATION && oneLineAddress) {
      event.location = oneLineAddress;
    } else if (this.locationMode === CONCISE_LOCATION) {
      const firstLine = fetchResult.location?.formatted_address[0];
      const city = fetchResult.location?.city;
      const state_province = fetchResult.location?.state_province;
      if (firstLine && city) {
        event.location = `${firstLine}, ${city} ${state_province}`;
      } else {
        // TODO: warning
      }
    }

    return event;
  }
}
