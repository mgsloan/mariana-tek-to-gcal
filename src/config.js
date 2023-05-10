const CONFIG = {
  sources: [
    MarianaTek({
      // Name used for logging and error reporting
      name: 'My Mariana Tek Event Source',

      // A prefix added to calendar IDs, to distinguish which source produced it.
      // Note that if you change this and don't delete events that use the old
      // prefix, it will cause duplicate events.
      idPrefix: 'imported-',

      // Source-specific fields:

      brand: 'BRAND_HERE',
      pastDaysToFetch: 1,
      futureDaysToFetch: 30,
      includeReserveLink: true,
      includePhoneNumber: false,
      includeEmail: true,
      includeAddress: true,
      locationMode: CONCISE_LOCATION,
      customPrefix: '',
      customSuffix: '',
      targetCalendar: 'primary',
    }),
  ],
};
