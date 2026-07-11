import { extractWindows, applyWindows, windowBaseColumns, hasWindows } from './compensate';

describe('Capability Compensation Engine — window functions', () => {
  const rows = () => [
    { region: 'EU', amount: 100, id: 1 },
    { region: 'EU', amount: 300, id: 2 },
    { region: 'EU', amount: 300, id: 3 },
    { region: 'NA', amount: 50, id: 4 },
    { region: 'NA', amount: 90, id: 5 },
  ];

  it('detects + extracts window specs', () => {
    const select = ['region', { window: 'RANK', partitionBy: ['region'], orderBy: [{ column: 'amount', direction: 'DESC' }], alias: 'rnk' }];
    expect(hasWindows(select)).toBe(true);
    expect(windowBaseColumns(select)).toEqual(expect.arrayContaining(['region', 'amount']));
  });

  it('RANK / DENSE_RANK / ROW_NUMBER per partition with ties', () => {
    const specs = extractWindows([
      { window: 'RANK', partitionBy: ['region'], orderBy: [{ column: 'amount', direction: 'DESC' }], alias: 'rnk' },
      { window: 'DENSE_RANK', partitionBy: ['region'], orderBy: [{ column: 'amount', direction: 'DESC' }], alias: 'dense' },
      { window: 'ROW_NUMBER', partitionBy: ['region'], orderBy: [{ column: 'amount', direction: 'DESC' }], alias: 'rn' },
    ]);
    const out = applyWindows(rows(), specs);
    const eu = out.filter((r) => r.region === 'EU').sort((a, b) => a.rn - b.rn);
    // amounts 300,300,100 → ranks 1,1,3 ; dense 1,1,2 ; row_number 1,2,3
    expect(eu.map((r) => r.rnk)).toEqual([1, 1, 3]);
    expect(eu.map((r) => r.dense)).toEqual([1, 1, 2]);
    expect(eu.map((r) => r.rn)).toEqual([1, 2, 3]);
  });

  it('running SUM and LAG per partition', () => {
    const specs = extractWindows([
      { window: 'SUM', column: 'amount', partitionBy: ['region'], orderBy: [{ column: 'id', direction: 'ASC' }], alias: 'running' },
      { window: 'LAG', column: 'amount', partitionBy: ['region'], orderBy: [{ column: 'id', direction: 'ASC' }], alias: 'prev' },
    ]);
    const out = applyWindows(rows(), specs);
    const na = out.filter((r) => r.region === 'NA').sort((a, b) => a.id - b.id);
    expect(na.map((r) => r.running)).toEqual([50, 140]); // 50, 50+90
    expect(na.map((r) => r.prev)).toEqual([null, 50]);
  });
});
