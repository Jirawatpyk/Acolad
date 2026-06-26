export function parseHHMM(s: string): number {
  const m = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(s.trim());
  if (!m) throw new Error(`invalid HH:MM time: '${s}'`);
  return Number(m[1]) * 60 + Number(m[2]);
}

export function parseWorkdays(s: string): Set<number> {
  const out = new Set<number>();
  for (const part of s
    .split(',')
    .map((x) => x.trim())
    .filter(Boolean)) {
    const range = /^([1-7])-([1-7])$/.exec(part);
    if (range) {
      const [a, b] = [Number(range[1]), Number(range[2])];
      if (a > b) throw new Error(`invalid workday range: '${part}'`);
      for (let d = a; d <= b; d++) out.add(d);
    } else if (/^[1-7]$/.test(part)) {
      out.add(Number(part));
    } else {
      throw new Error(`invalid workday token: '${part}'`);
    }
  }
  if (out.size === 0) throw new Error(`ACCEPT_WORKDAYS parsed to an empty set: '${s}'`);
  return out;
}

export function resolveThroughput(o: {
  explicit?: number;
  maxWordsPerDay: number;
  hoursStartMin: number;
  hoursEndMin: number;
}): number {
  if (o.explicit !== undefined) return o.explicit;
  const workingHoursPerDay = (o.hoursEndMin - o.hoursStartMin) / 60;
  return o.maxWordsPerDay / workingHoursPerDay;
}
