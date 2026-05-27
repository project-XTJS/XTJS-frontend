export function normalizeProjectResultsPayload(data) {
  const candidates = [
    data?.results,
    data?.result,
    data?.result_record?.result,
    data?.data?.results,
    data?.data?.result,
    data,
  ]

  return candidates.find((item) => item && typeof item === 'object' && !Array.isArray(item)) ?? {}
}
