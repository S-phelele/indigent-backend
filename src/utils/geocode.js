/**
 * Geocode an address using Google Maps Geocoding API.
 * Requires GOOGLE_MAPS_API_KEY in environment.
 * Enable "Geocoding API" in Google Cloud Console.
 */

async function geocodeAddress(address) {
  const apiKey = process.env.GOOGLE_MAPS_API_KEY;

  if (!apiKey || !apiKey.trim()) {
    const err = new Error(
      'Google Maps is not configured. Set GOOGLE_MAPS_API_KEY in the backend .env file.'
    );
    err.code = 'NO_API_KEY';
    throw err;
  }

  if (!address || !String(address).trim()) {
    const err = new Error('Address is required');
    err.code = 'INVALID_ADDRESS';
    throw err;
  }

  const params = new URLSearchParams({
    address: String(address).trim(),
    key: apiKey.trim(),
    // Bias results toward South Africa (municipal indigent context)
    region: 'za',
    components: 'country:ZA',
  });

  const url = `https://maps.googleapis.com/maps/api/geocode/json?${params.toString()}`;

  const response = await fetch(url);
  if (!response.ok) {
    const err = new Error(`Google Geocoding HTTP error: ${response.status}`);
    err.code = 'GEOCODE_HTTP';
    throw err;
  }

  const data = await response.json();

  if (data.status === 'ZERO_RESULTS') {
    const err = new Error('No location found for this address. Please check and try again.');
    err.code = 'ZERO_RESULTS';
    throw err;
  }

  if (data.status === 'REQUEST_DENIED') {
    const err = new Error(
      data.error_message ||
        'Google Maps request denied. Check that Geocoding API is enabled and the API key is valid.'
    );
    err.code = 'REQUEST_DENIED';
    throw err;
  }

  if (data.status === 'OVER_QUERY_LIMIT') {
    const err = new Error('Google Maps quota exceeded. Please try again later.');
    err.code = 'OVER_QUERY_LIMIT';
    throw err;
  }

  if (data.status !== 'OK' || !data.results?.length) {
    const err = new Error(data.error_message || `Geocoding failed: ${data.status}`);
    err.code = data.status || 'GEOCODE_FAILED';
    throw err;
  }

  const result = data.results[0];
  const location = result.geometry?.location;

  if (!location || location.lat == null || location.lng == null) {
    const err = new Error('Invalid geocoding response from Google');
    err.code = 'INVALID_RESPONSE';
    throw err;
  }

  return {
    latitude: location.lat,
    longitude: location.lng,
    formattedAddress: result.formatted_address,
    placeId: result.place_id || null,
    locationType: result.geometry.location_type || null,
    partialMatch: !!result.partial_match,
    types: result.types || [],
  };
}

module.exports = { geocodeAddress };
