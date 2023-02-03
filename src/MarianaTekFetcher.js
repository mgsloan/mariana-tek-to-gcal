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
