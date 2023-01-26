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
