function matchesCronField(field: string, value: number): boolean {
  if (field === '*') {
    return true;
  }

  if (field.startsWith('*/')) {
    const step = Number.parseInt(field.slice(2), 10);
    return Number.isInteger(step) && step > 0 && value % step === 0;
  }

  const exactValue = Number.parseInt(field, 10);
  return Number.isInteger(exactValue) && exactValue === value;
}

export function matchesCronExpression(cronExpression: string, date: Date): boolean {
  const parts = cronExpression.trim().split(/\s+/);
  if (parts.length !== 5) {
    return false;
  }

  const [minuteField, hourField, dayOfMonthField, monthField, dayOfWeekField] = parts;

  return (
    matchesCronField(minuteField, date.getUTCMinutes()) &&
    matchesCronField(hourField, date.getUTCHours()) &&
    matchesCronField(dayOfMonthField, date.getUTCDate()) &&
    matchesCronField(monthField, date.getUTCMonth() + 1) &&
    matchesCronField(dayOfWeekField, date.getUTCDay())
  );
}
