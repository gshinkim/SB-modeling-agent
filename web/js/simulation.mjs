// Numeric inputs must preserve zero. An empty field is incomplete, rather than a
// request to silently fall back to a different simulation window.
export function simulationSettings({ start, end, points }){
  const number = value => String(value ?? '').trim() === '' ? NaN : Number(value);
  return { start: number(start), end: number(end), points: number(points) };
}

export function simulationError(settings, steady = false){
  if(!Number.isInteger(settings.points) || settings.points < 2 || settings.points > 20000)
    return 'Points must be a whole number from 2 to 20,000';
  if(!steady && (!Number.isFinite(settings.start) || !Number.isFinite(settings.end)))
    return 'Enter a finite start and end time';
  if(!steady && settings.end <= settings.start) return 'End time must exceed start';
  return '';
}
