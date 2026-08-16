export function getLocalCapabilities(platform: NodeJS.Platform = process.platform) {
  const macVisual = platform === "darwin";
  return {
    platform,
    local: {
      filesystemRead: true,
      filesystemWrite: true,
      shell: true,
      terminal: true,
      processes: true,
      projectContext: true,
      codeSearch: true,
      gitReview: true,
    },
    vision: {
      uiContext: macVisual,
      screenshots: macVisual,
      // Do not trigger a screenshot merely to probe permission; that would violate task-driven capture.
      screenRecordingPermission: "unknown" as const,
    },
  };
}
