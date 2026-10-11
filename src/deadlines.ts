const SAO_PAULO_DAY_FORMATTER = new Intl.DateTimeFormat("en-US-u-ca-gregory-nu-latn", {
  timeZone: "America/Sao_Paulo",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

export function approvedCivilDay(approvedAt: string): string {
  const date = new Date(approvedAt);
  const parts = SAO_PAULO_DAY_FORMATTER.formatToParts(date);
  const part = (type: "year" | "month" | "day") => parts.find((item) => item.type === type)?.value;
  const year = part("year");
  const month = part("month");
  const day = part("day");

  if (!year || !month || !day) throw new RangeError("data de aprovação inválida");
  return `${year.padStart(4, "0")}-${month}-${day}`;
}

export function isPastDeadline(approvedAt: string, deadlineDate: string): boolean {
  return approvedCivilDay(approvedAt) > deadlineDate;
}
