import { describe, it, beforeEach, afterEach } from "node:test";
import { strict as assert } from "node:assert";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  diagnoseAndroidBuild,
  type AndroidBuildDiagnosticReport,
} from "../../tools/androidDoctor.js";

const VALID_STATUSES = ["ok", "warn", "fail", "skip"] as const;

/** Restore an env var to its original value (deleted when undefined). */
function restoreEnv(key: string, value: string | undefined) {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}

describe("diagnoseAndroidBuild", () => {
  let tempDir: string;
  let savedJavaHome: string | undefined;
  let savedAndroidHome: string | undefined;
  let savedAndroidSdkRoot: string | undefined;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "pw-android-doctor-"));
    savedJavaHome = process.env.JAVA_HOME;
    savedAndroidHome = process.env.ANDROID_HOME;
    savedAndroidSdkRoot = process.env.ANDROID_SDK_ROOT;
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
    restoreEnv("JAVA_HOME", savedJavaHome);
    restoreEnv("ANDROID_HOME", savedAndroidHome);
    restoreEnv("ANDROID_SDK_ROOT", savedAndroidSdkRoot);
  });

  it("returns a skip result when no android_app directory exists", () => {
    const result = diagnoseAndroidBuild(tempDir);
    assert.equal(result.status, "skip");
    assert.equal((result as { reason: string }).reason, "No android_app directory found");
  });

  it("returns a structured diagnostic report when android_app exists", () => {
    const androidApp = join(tempDir, "android_app");
    mkdirSync(join(androidApp, "app"), { recursive: true });
    mkdirSync(join(androidApp, "gradle", "wrapper"), { recursive: true });
    writeFileSync(join(androidApp, "gradlew"), "#!/bin/sh\necho gradle\n");
    writeFileSync(join(androidApp, "settings.gradle.kts"), 'pluginManagement { repositories { google() } }\n');
    writeFileSync(join(androidApp, "app", "build.gradle.kts"), 'plugins { id("com.android.application") }\n');
    writeFileSync(
      join(androidApp, "gradle", "wrapper", "gradle-wrapper.properties"),
      "distributionUrl=https://services.gradle.org/distributions/gradle-8.5-bin.zip\n",
    );

    // Make SDK-related checks deterministic regardless of the host environment.
    delete process.env.ANDROID_HOME;
    delete process.env.ANDROID_SDK_ROOT;

    const result = diagnoseAndroidBuild(tempDir);
    assert.notEqual(result.status, "skip");
    const report = result as AndroidBuildDiagnosticReport;

    assert.equal(report.repo_path, tempDir);
    assert.equal(report.android_app_path, join(tempDir, "android_app"));
    assert.ok(Array.isArray(report.checks));
    assert.equal(report.checks.length, 10);

    for (const item of report.checks) {
      assert.equal(typeof item.check, "string");
      assert.ok(item.check.length > 0);
      assert.ok((VALID_STATUSES as readonly string[]).includes(item.status));
      assert.equal(typeof item.reason, "string");
      assert.equal(typeof item.suggested_fix, "string");
    }

    // Overall status follows the fail > warn > ok precedence.
    const hasFail = report.checks.some((c) => c.status === "fail");
    const hasWarn = report.checks.some((c) => c.status === "warn");
    const expected = hasFail ? "fail" : hasWarn ? "warn" : "ok";
    assert.equal(report.status, expected);

    // The expected check names are all present.
    const checkNames = report.checks.map((c) => c.check);
    assert.ok(checkNames.includes("java -version"));
    assert.ok(checkNames.includes("JAVA_HOME"));
    assert.ok(checkNames.includes("ANDROID_HOME"));
    assert.ok(checkNames.includes("ANDROID_SDK_ROOT"));
    assert.ok(checkNames.includes("Android SDK platform"));
    assert.ok(checkNames.includes("Android build-tools"));
    assert.ok(checkNames.includes("Gradle wrapper"));
    assert.ok(checkNames.includes("android_app/settings.gradle.kts"));
    assert.ok(checkNames.includes("android_app/app/build.gradle.kts"));
    assert.ok(checkNames.includes("APK output path"));

    // Files we created should be detected as ok.
    const gradleCheck = report.checks.find((c) => c.check === "Gradle wrapper");
    assert.equal(gradleCheck?.status, "ok");

    const settingsCheck = report.checks.find((c) => c.check === "android_app/settings.gradle.kts");
    assert.equal(settingsCheck?.status, "ok");

    const appBuildCheck = report.checks.find((c) => c.check === "android_app/app/build.gradle.kts");
    assert.equal(appBuildCheck?.status, "ok");
  });

  it("reports a missing JAVA_HOME as warn or fail", () => {
    const androidApp = join(tempDir, "android_app");
    mkdirSync(androidApp, { recursive: true });

    delete process.env.JAVA_HOME;
    delete process.env.ANDROID_HOME;
    delete process.env.ANDROID_SDK_ROOT;

    const result = diagnoseAndroidBuild(tempDir);
    const report = result as AndroidBuildDiagnosticReport;
    const javaHomeCheck = report.checks.find((c) => c.check === "JAVA_HOME");
    assert.ok(javaHomeCheck, "JAVA_HOME check should exist");
    assert.ok(
      javaHomeCheck!.status === "warn" || javaHomeCheck!.status === "fail",
      `expected warn or fail, got ${javaHomeCheck!.status}`,
    );
  });

  it("reports a missing ANDROID_HOME as fail with the SDK-missing message", () => {
    const androidApp = join(tempDir, "android_app");
    mkdirSync(androidApp, { recursive: true });

    delete process.env.ANDROID_HOME;
    delete process.env.ANDROID_SDK_ROOT;

    const result = diagnoseAndroidBuild(tempDir);
    const report = result as AndroidBuildDiagnosticReport;
    const androidHomeCheck = report.checks.find((c) => c.check === "ANDROID_HOME");
    assert.ok(androidHomeCheck, "ANDROID_HOME check should exist");
    assert.equal(androidHomeCheck!.status, "fail");
    assert.ok(
      androidHomeCheck!.reason.includes(
        "Android project exists, APK not built because Android SDK is missing.",
      ),
      `reason should mention the SDK-missing sentence, got: ${androidHomeCheck!.reason}`,
    );

    // With the SDK missing, the overall status must be fail.
    assert.equal(report.status, "fail");

    // The APK output check should also carry the SDK-missing reason and be skipped.
    const apkCheck = report.checks.find((c) => c.check === "APK output path");
    assert.ok(apkCheck, "APK output path check should exist");
    assert.equal(apkCheck!.status, "skip");
    assert.ok(
      apkCheck!.reason.includes(
        "Android project exists, APK not built because Android SDK is missing.",
      ),
    );
  });
});
