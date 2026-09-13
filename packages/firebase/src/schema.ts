export interface SessionDocument {
  lockActive: boolean;
  startTime: number;
  endTime: number;
  distractionList: string[];
}

export interface UserDocument {
  username: string;
  usernameSet: boolean;
  config: {
    onboardingComplete: boolean;
    lockMode: "soft" | "hard";
    autostartEnabled: boolean;
    focusActive: boolean;
    lastResetDate: string;
    userName: string;
  };
}
