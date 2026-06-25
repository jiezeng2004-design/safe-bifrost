/**
 * PatchWarden Android Doctor — read-only Android build environment diagnostics.
 *
 * Inspects a repository for an `android_app` directory and reports whether the
 * local environment can build an APK. The module is strictly read-only: it never
 * auto-downloads the Android SDK, never modifies system environment variables,
 * and never installs global dependencies. It only runs `java -version` (read-only)
 * and inspects files/directories/env vars that already exist.
 */

import { execSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

// ── Types ──────────────────────────────────────────────────────────

export type AndroidCheckStatus = "ok" | "warn" | "fail" | "skip";

export interface AndroidDiagnosticItem {
  check: string;
  status: AndroidCheckStatus;
  reason: string;
  suggested_fix: string;
}

export interface AndroidBuildDiagnosticReport {
  status: "ok" | "warn" | "fail";
  repo_path: string;
  android_app_path: string;
  checks: AndroidDiagnosticItem[];
  checked_at: string;
}

export type AndroidBuildDiagnostic =
  | { status: "skip"; reason: string }
  | AndroidBuildDiagnosticReport;

// ── Constants ──────────────────────────────────────────────────────

/**
 * Required explanatory sentence emitted whenever the Android SDK is missing.
 * Callers rely on this exact wording to detect the "SDK missing" condition.
 */
const SDK_MISSING_REASON =
  "Android project exists, APK not built because Android SDK is missing.";

// ── Helpers ────────────────────────────────────────────────────────

/**
 * Run a shell command and return its trimmed combined stdout/stderr output.
 * Returns an empty string when the command is missing or fails so callers can
 * treat absence gracefully. A timeout guards against hanging processes.
 */
function runCmd(cmdStr: string): string {
  try {
    return execSync(cmdStr, {
      encoding: "utf-8",
      timeout: 8000,
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return "";
  }
}

/** True when `path` exists and is a directory. Never throws. */
function isDirectory(path: string): boolean {
  try {
    return existsSync(path) && statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/** Extract the quoted version token from `java -version` output. */
function parseJavaVersion(output: string): string | null {
  const match = output.match(/version "([^"]+)"/);
  return match ? match[1] : null;
}

/**
 * Convert a Java version string to its major version number.
 * "17.0.1" -> 17, "21" -> 21, "1.8.0_292" -> 8 (legacy 1.x scheme).
 */
function parseJavaMajor(version: string): number | null {
  const match = version.match(/^(\d+)(?:\.(\d+))?/);
  if (!match) return null;
  const major = parseInt(match[1], 10);
  if (major === 1 && match[2]) return parseInt(match[2], 10);
  return major;
}

/** Safely read a UTF-8 file, returning null on any error. */
function readTextFile(path: string): string | null {
  try {
    return readFileSync(path, "utf-8");
  } catch {
    return null;
  }
}

// ── Public API ─────────────────────────────────────────────────────

/**
 * Diagnose the Android build readiness for the repository at `repoPath`.
 *
 * - If `<repoPath>/android_app` does not exist, returns a skip result.
 * - Otherwise runs 10 read-only checks and returns a structured report with an
 *   overall status: "fail" if any check failed, "warn" if any warned, else "ok".
 *
 * This function performs no mutations: it does not download the SDK, change env
 * vars, or install dependencies.
 */
export function diagnoseAndroidBuild(repoPath: string): AndroidBuildDiagnostic {
  const androidAppPath = join(repoPath, "android_app");
  if (!isDirectory(androidAppPath)) {
    return { status: "skip", reason: "No android_app directory found" };
  }

  const checks: AndroidDiagnosticItem[] = [];
  const checkedAt = new Date().toISOString();

  // Resolve the Android SDK location. ANDROID_HOME is preferred; ANDROID_SDK_ROOT
  // is a legacy fallback that some tools still honor.
  const androidHomeEnv = process.env.ANDROID_HOME || "";
  const androidSdkRootEnv = process.env.ANDROID_SDK_ROOT || "";
  const sdkRoot = androidHomeEnv || androidSdkRootEnv;
  const sdkExists = sdkRoot !== "" && isDirectory(sdkRoot);

  // 1. java -version ------------------------------------------------------
  // `java -version` writes to stderr; redirect with 2>&1 so execSync captures it.
  const javaOutput = runCmd("java -version 2>&1");
  const javaVersion = parseJavaVersion(javaOutput);
  if (javaVersion) {
    const major = parseJavaMajor(javaVersion);
    if (major !== null && major < 17) {
      checks.push({
        check: "java -version",
        status: "warn",
        reason: `Java ${javaVersion} found. Modern Android Gradle Plugin (8.x) requires JDK 17+.`,
        suggested_fix:
          "Install JDK 17 or newer and place it first on PATH (or point JAVA_HOME at it).",
      });
    } else {
      checks.push({
        check: "java -version",
        status: "ok",
        reason: `Java ${javaVersion} is available on PATH.`,
        suggested_fix: "",
      });
    }
  } else {
    checks.push({
      check: "java -version",
      status: "fail",
      reason: "java command not found or did not report a version.",
      suggested_fix:
        "Install a JDK (17+ recommended for modern Android) and add its bin directory to PATH.",
    });
  }

  // 2. JAVA_HOME ----------------------------------------------------------
  const javaHome = process.env.JAVA_HOME || "";
  if (javaHome && isDirectory(javaHome)) {
    checks.push({
      check: "JAVA_HOME",
      status: "ok",
      reason: `JAVA_HOME is set to ${javaHome}.`,
      suggested_fix: "",
    });
  } else if (javaHome) {
    checks.push({
      check: "JAVA_HOME",
      status: "warn",
      reason: `JAVA_HOME is set to "${javaHome}" but that directory does not exist.`,
      suggested_fix: "Point JAVA_HOME at a valid JDK installation directory.",
    });
  } else {
    checks.push({
      check: "JAVA_HOME",
      status: "warn",
      reason: "JAVA_HOME is not set. Gradle may be unable to locate the JDK.",
      suggested_fix:
        "Set JAVA_HOME to your JDK installation (e.g. C:\\Program Files\\Java\\jdk-17).",
    });
  }

  // 3. ANDROID_HOME -------------------------------------------------------
  if (!androidHomeEnv) {
    if (!sdkExists) {
      checks.push({
        check: "ANDROID_HOME",
        status: "fail",
        reason: `ANDROID_HOME is not set. ${SDK_MISSING_REASON}`,
        suggested_fix:
          "Install the Android SDK and set ANDROID_HOME to its root directory " +
          "(e.g. C:\\Users\\<you>\\AppData\\Local\\Android\\Sdk).",
      });
    } else {
      checks.push({
        check: "ANDROID_HOME",
        status: "warn",
        reason:
          "ANDROID_HOME is not set. ANDROID_SDK_ROOT points at an SDK, but ANDROID_HOME is the preferred variable.",
        suggested_fix: "Set ANDROID_HOME to the same value as ANDROID_SDK_ROOT.",
      });
    }
  } else if (!isDirectory(androidHomeEnv)) {
    checks.push({
      check: "ANDROID_HOME",
      status: "fail",
      reason:
        `ANDROID_HOME is set to "${androidHomeEnv}" but that directory does not exist.` +
        (sdkExists ? "" : ` ${SDK_MISSING_REASON}`),
      suggested_fix:
        "Install the Android SDK at the ANDROID_HOME path, or correct the variable to point at an existing SDK.",
    });
  } else {
    checks.push({
      check: "ANDROID_HOME",
      status: "ok",
      reason: `ANDROID_HOME is set to ${androidHomeEnv}.`,
      suggested_fix: "",
    });
  }

  // 4. ANDROID_SDK_ROOT ---------------------------------------------------
  if (androidSdkRootEnv && isDirectory(androidSdkRootEnv)) {
    checks.push({
      check: "ANDROID_SDK_ROOT",
      status: "ok",
      reason: `ANDROID_SDK_ROOT is set to ${androidSdkRootEnv}.`,
      suggested_fix: "",
    });
  } else if (androidSdkRootEnv) {
    checks.push({
      check: "ANDROID_SDK_ROOT",
      status: "warn",
      reason: `ANDROID_SDK_ROOT is set to "${androidSdkRootEnv}" but that directory does not exist.`,
      suggested_fix: "Point ANDROID_SDK_ROOT at a valid Android SDK directory.",
    });
  } else {
    checks.push({
      check: "ANDROID_SDK_ROOT",
      status: "warn",
      reason:
        "ANDROID_SDK_ROOT is not set. Some tools fall back to ANDROID_HOME, but setting both is recommended.",
      suggested_fix: "Set ANDROID_SDK_ROOT to the same value as ANDROID_HOME.",
    });
  }

  // 5. Android SDK platform ----------------------------------------------
  if (!sdkExists) {
    checks.push({
      check: "Android SDK platform",
      status: "skip",
      reason: `Skipped: Android SDK not available. ${SDK_MISSING_REASON}`,
      suggested_fix: "Install the Android SDK and a platform via sdkmanager.",
    });
  } else {
    const platformsDir = join(sdkRoot, "platforms");
    if (isDirectory(platformsDir)) {
      checks.push({
        check: "Android SDK platform",
        status: "ok",
        reason: `Android SDK platforms directory found at ${platformsDir}.`,
        suggested_fix: "",
      });
    } else {
      checks.push({
        check: "Android SDK platform",
        status: "warn",
        reason: `No platforms directory found at ${platformsDir}. No Android platform is installed.`,
        suggested_fix: 'Run: sdkmanager "platforms;android-34"',
      });
    }
  }

  // 6. Android build-tools ------------------------------------------------
  if (!sdkExists) {
    checks.push({
      check: "Android build-tools",
      status: "skip",
      reason: `Skipped: Android SDK not available. ${SDK_MISSING_REASON}`,
      suggested_fix: "Install the Android SDK and build-tools via sdkmanager.",
    });
  } else {
    const buildToolsDir = join(sdkRoot, "build-tools");
    if (isDirectory(buildToolsDir)) {
      checks.push({
        check: "Android build-tools",
        status: "ok",
        reason: `Android build-tools directory found at ${buildToolsDir}.`,
        suggested_fix: "",
      });
    } else {
      checks.push({
        check: "Android build-tools",
        status: "warn",
        reason: `No build-tools directory found at ${buildToolsDir}.`,
        suggested_fix: 'Run: sdkmanager "build-tools;34.0.0"',
      });
    }
  }

  // 7. Gradle wrapper -----------------------------------------------------
  const gradlewUnix = join(androidAppPath, "gradlew");
  const gradlewWin = join(androidAppPath, "gradlew.bat");
  const wrapperProps = join(androidAppPath, "gradle", "wrapper", "gradle-wrapper.properties");
  let gradleVersion: string | null = null;
  const propsContent = readTextFile(wrapperProps);
  if (propsContent) {
    const match = propsContent.match(/gradle-([\d.]+)-/);
    gradleVersion = match ? match[1] : null;
  }
  if (existsSync(gradlewUnix) || existsSync(gradlewWin)) {
    checks.push({
      check: "Gradle wrapper",
      status: "ok",
      reason: gradleVersion
        ? `Gradle wrapper found in android_app (Gradle ${gradleVersion}).`
        : "Gradle wrapper found in android_app.",
      suggested_fix: "",
    });
  } else {
    checks.push({
      check: "Gradle wrapper",
      status: "warn",
      reason: "No gradlew or gradlew.bat found in android_app.",
      suggested_fix:
        "Generate the wrapper inside android_app with: gradle wrapper  (or copy gradlew/gradlew.bat/gradle-wrapper.jar from an existing project).",
    });
  }

  // 8. settings.gradle.kts -----------------------------------------------
  const settingsGradleKts = join(androidAppPath, "settings.gradle.kts");
  const settingsGradleGroovy = join(androidAppPath, "settings.gradle");
  if (existsSync(settingsGradleKts)) {
    checks.push({
      check: "android_app/settings.gradle.kts",
      status: "ok",
      reason: "settings.gradle.kts found in android_app.",
      suggested_fix: "",
    });
  } else if (existsSync(settingsGradleGroovy)) {
    checks.push({
      check: "android_app/settings.gradle.kts",
      status: "warn",
      reason: "settings.gradle.kts not found, but settings.gradle (Groovy DSL) is present.",
      suggested_fix: "Kotlin DSL is preferred; consider migrating settings.gradle to settings.gradle.kts.",
    });
  } else {
    checks.push({
      check: "android_app/settings.gradle.kts",
      status: "warn",
      reason: "settings.gradle.kts not found in android_app.",
      suggested_fix: "Create android_app/settings.gradle.kts declaring the project modules.",
    });
  }

  // 9. app/build.gradle.kts ----------------------------------------------
  const appBuildGradleKts = join(androidAppPath, "app", "build.gradle.kts");
  const appBuildGradleGroovy = join(androidAppPath, "app", "build.gradle");
  if (existsSync(appBuildGradleKts)) {
    checks.push({
      check: "android_app/app/build.gradle.kts",
      status: "ok",
      reason: "app/build.gradle.kts found.",
      suggested_fix: "",
    });
  } else if (existsSync(appBuildGradleGroovy)) {
    checks.push({
      check: "android_app/app/build.gradle.kts",
      status: "warn",
      reason: "app/build.gradle.kts not found, but app/build.gradle (Groovy DSL) is present.",
      suggested_fix: "Kotlin DSL is preferred; consider migrating app/build.gradle to app/build.gradle.kts.",
    });
  } else {
    checks.push({
      check: "android_app/app/build.gradle.kts",
      status: "warn",
      reason: "app/build.gradle.kts not found in android_app/app.",
      suggested_fix: "Create android_app/app/build.gradle.kts with the Android application plugin and build config.",
    });
  }

  // 10. APK output path ---------------------------------------------------
  const apkDir = join(androidAppPath, "app", "build", "outputs", "apk");
  if (!sdkExists) {
    checks.push({
      check: "APK output path",
      status: "skip",
      reason: SDK_MISSING_REASON,
      suggested_fix: "Install the Android SDK, then build with: cd android_app && ./gradlew assembleDebug",
    });
  } else if (isDirectory(apkDir)) {
    checks.push({
      check: "APK output path",
      status: "ok",
      reason: `APK output directory found at ${apkDir}.`,
      suggested_fix: "",
    });
  } else {
    checks.push({
      check: "APK output path",
      status: "warn",
      reason: "APK output directory not found. The project has not been built yet.",
      suggested_fix: "Build the APK: cd android_app && ./gradlew assembleDebug",
    });
  }

  // Overall status: fail dominates warn dominates ok.
  const hasFail = checks.some((c) => c.status === "fail");
  const hasWarn = checks.some((c) => c.status === "warn");
  const overall: "ok" | "warn" | "fail" = hasFail ? "fail" : hasWarn ? "warn" : "ok";

  return {
    status: overall,
    repo_path: repoPath,
    android_app_path: androidAppPath,
    checks,
    checked_at: checkedAt,
  };
}
