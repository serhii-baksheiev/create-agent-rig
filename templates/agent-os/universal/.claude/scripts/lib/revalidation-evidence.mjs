/** Resolution indexes shared by selection and the aggregate report. */
export const typedResolutionsOf = (events = []) => {
  const resolutions = new Map();
  for (const event of events) {
    const actionRequired = event.data?.actionRequired ?? event.data?.actionChanged;
    if (
      event.kind !== 'revalidation-outcome' ||
      typeof event.data?.detectionId !== 'string' ||
      typeof actionRequired !== 'boolean'
    ) {
      continue;
    }
    const resolvedAt = Date.parse(event.data?.resolvedAt ?? event.at);
    if (!Number.isFinite(resolvedAt)) continue;
    const matching = resolutions.get(event.data.detectionId) ?? [];
    matching.push({ resolvedAt, data: event.data });
    resolutions.set(event.data.detectionId, matching);
  }
  return resolutions;
};

export const typedResolutionOf = (resolutions, event) => {
  const detectionAt = Date.parse(event.at);
  if (typeof event.data?.id !== 'string' || !Number.isFinite(detectionAt)) return null;
  return (
    (resolutions.get(event.data.id) ?? [])
      .filter((resolution) => resolution.resolvedAt >= detectionAt)
      .sort((left, right) => left.resolvedAt - right.resolvedAt)[0]?.data ?? null
  );
};

/** The newest blocking detection in one run that no typed outcome resolves. */
export const unresolvedBlockingDetectionOf = (events = []) => {
  const resolutions = typedResolutionsOf(events);
  for (const event of [...events].reverse()) {
    if (event.kind !== 'revalidation') continue;
    const result = event.data?.result;
    if (!['CHANGED', 'CONFLICT', 'UNVERIFIABLE'].includes(result)) continue;
    if (typedResolutionOf(resolutions, event)) continue;
    if (
      typeof event.data?.id !== 'string' ||
      typeof event.data?.ticket !== 'string' ||
      typeof (event.data?.checkpoint ?? event.data?.point) !== 'string'
    ) {
      continue;
    }
    return {
      kind: 'revalidation-hold',
      ticket: event.data.ticket,
      checkpoint: event.data.checkpoint ?? event.data.point,
      result,
      detectionId: event.data.id,
    };
  }
  return null;
};
