import { readFileSync } from "fs";
import { resolve } from "path";

describe("release workflow", () => {
  const workflow = readFileSync(
    resolve(".github/workflows/release.yml"),
    "utf8",
  );

  it("creates a versioned release and advances the floating v1 tag", () => {
    expect(workflow).toContain("contents: write");
    expect(workflow).toContain('gh release create "$RELEASE_VERSION"');
    expect(workflow).toContain('--target "$GITHUB_SHA"');
    expect(workflow).toContain('git tag --force v1 "$GITHUB_SHA"');
    expect(workflow).toContain("git push --force origin v1");
  });

  it("does not commit release metadata directly to the protected branch", () => {
    expect(workflow).not.toContain("npm version");
    expect(workflow).not.toContain("git push origin main");
    expect(workflow).not.toContain("actions/create-release");
  });
});
