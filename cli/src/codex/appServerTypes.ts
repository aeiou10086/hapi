export type ApprovalPolicy = 'untrusted' | 'on-failure' | 'on-request' | 'never';
export type SandboxMode = 'read-only' | 'workspace-write' | 'danger-full-access';

export interface InitializeCapabilities {
    experimentalApi: boolean;
}

export interface InitializeParams {
    clientInfo: {
        name: string;
        title?: string;
        version: string;
    };
    capabilities: InitializeCapabilities | null;
}

export interface InitializeResponse {
    userAgent?: string;
    [key: string]: unknown;
}

export interface ThreadStartParams {
    model?: string;
    modelProvider?: string;
    cwd?: string;
    approvalPolicy?: ApprovalPolicy;
    sandbox?: SandboxMode;
    config?: Record<string, unknown>;
    baseInstructions?: string;
    developerInstructions?: string;
    personality?: string;
    ephemeral?: boolean;
    experimentalRawEvents?: boolean;
}

export interface ThreadStartResponse {
    thread: {
        id: string;
    };
    model: string;
    [key: string]: unknown;
}

export type ResponseItem = Record<string, unknown>;

export interface ThreadResumeParams {
    threadId: string;
    history?: ResponseItem[];
    path?: string;
    model?: string;
    modelProvider?: string;
    cwd?: string;
    approvalPolicy?: ApprovalPolicy;
    sandbox?: SandboxMode;
    config?: Record<string, unknown>;
    baseInstructions?: string;
    developerInstructions?: string;
    personality?: string;
}

export interface ThreadResumeResponse {
    thread: {
        id: string;
    };
    model: string;
    [key: string]: unknown;
}

export type UserInput =
    | {
        type: 'text';
        text: string;
        textElements?: Array<{
            byteRange: { start: number; end: number };
            placeholder?: string;
        }>;
    }
    | {
        type: 'image';
        url: string;
    }
    | {
        type: 'localImage';
        path: string;
    }
    | {
        type: 'skill';
        name: string;
        path: string;
    };

export type SandboxPolicy =
    | { type: 'dangerFullAccess' }
    | { type: 'readOnly' }
    | { type: 'externalSandbox'; networkAccess?: 'restricted' | 'enabled' }
    | {
        type: 'workspaceWrite';
        writableRoots?: string[];
        networkAccess?: boolean;
        excludeTmpdirEnvVar?: boolean;
        excludeSlashTmp?: boolean;
    };

export type ReasoningEffort = 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh';
export type ReasoningSummary = 'auto' | 'none' | 'brief' | 'detailed';

export type CollaborationMode = {
    mode: 'plan' | 'default';
    settings: {
        model: string;
        reasoning_effort?: ReasoningEffort | null;
        developer_instructions?: string | null;
    };
};

export interface TurnStartParams {
    threadId: string;
    input: UserInput[];
    cwd?: string;
    approvalPolicy?: ApprovalPolicy;
    sandboxPolicy?: SandboxPolicy;
    model?: string;
    effort?: ReasoningEffort;
    summary?: ReasoningSummary;
    personality?: string;
    outputSchema?: unknown;
    collaborationMode?: CollaborationMode;
}

export interface TurnStartResponse {
    turn: {
        id: string;
        status?: string;
    };
    [key: string]: unknown;
}

export interface TurnInterruptParams {
    threadId: string;
    turnId: string;
}

export interface TurnInterruptResponse {
    ok: boolean;
    [key: string]: unknown;
}

export interface ThreadCompactStartParams {
    threadId: string;
}

export interface ThreadCompactStartResponse {
    [key: string]: unknown;
}

export type ReviewTarget =
    | { type: 'uncommittedChanges' }
    | { type: 'baseBranch'; branch: string }
    | { type: 'commit'; sha: string };

export interface ReviewStartParams {
    threadId: string;
    target: ReviewTarget;
    delivery?: 'inline' | 'detached';
}

export interface ReviewStartResponse {
    turn?: {
        id: string;
        status?: string;
    };
    reviewThreadId?: string;
    [key: string]: unknown;
}

export interface ThreadRollbackParams {
    threadId: string;
    numTurns: number;
}

export interface ThreadRollbackResponse {
    thread?: Record<string, unknown>;
    [key: string]: unknown;
}

export interface ThreadGoal {
    threadId?: string;
    objective?: string;
    status?: string;
    tokenBudget?: number | null;
    tokensUsed?: number;
    timeUsedSeconds?: number;
    createdAt?: number;
    updatedAt?: number;
    [key: string]: unknown;
}

export interface ThreadGoalGetParams {
    threadId: string;
}

export interface ThreadGoalGetResponse {
    goal?: ThreadGoal | null;
    [key: string]: unknown;
}

export interface ThreadGoalSetParams {
    threadId: string;
    objective: string;
    tokenBudget?: number | null;
    status?: string;
}

export interface ThreadGoalSetResponse {
    goal?: ThreadGoal | null;
    [key: string]: unknown;
}

export interface ThreadGoalClearParams {
    threadId: string;
}

export interface ThreadGoalClearResponse {
    goal?: ThreadGoal | null;
    [key: string]: unknown;
}

export interface GitDiffToRemoteParams {
    cwd: string;
}

export interface GitDiffToRemoteResponse {
    sha: string;
    diff: string;
    [key: string]: unknown;
}
