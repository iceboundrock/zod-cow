/**
 * 极简单元测试框架（零依赖，确定性输出）
 */
export let passed = 0;
export let failed = 0;
export const failures: string[] = [];

export function test(name: string, fn: () => void): void {
  try {
    fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (e) {
    failed++;
    const msg = e instanceof Error ? e.message : String(e);
    failures.push(`${name}\n      ${msg.split("\n").join("\n      ")}`);
    console.log(`  ✗ ${name}`);
  }
}

export function summary(suite: string): void {
  console.log(`\n${suite}: ${passed} passed, ${failed} failed`);
  if (failed > 0) {
    console.log("\nFailures:");
    for (const f of failures) console.log(`  - ${f}`);
    process.exitCode = 1;
  }
}
