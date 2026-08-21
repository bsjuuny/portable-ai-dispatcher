// Throwaway helper used only by shell-injection tests: prints argv as JSON so a test
// can assert a payload survived byte-for-byte through the real OS spawn path with no
// shell interpretation, without needing a real provider CLI installed.
process.stdout.write(JSON.stringify(process.argv.slice(2)));
