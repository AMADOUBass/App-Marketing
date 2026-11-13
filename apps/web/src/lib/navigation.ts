/** Leaving the app for an external page (Meta's login dialog). An object so tests can replace `go`. */
export const externalNavigation = {
  go(url: string): void {
    window.location.assign(url);
  },
};
