import { describe, expect, it } from 'vitest';
import { CodexCollaborationStateTracker } from './collaborationState';

describe('CodexCollaborationStateTracker', () => {
    it('tracks active collaboration calls and marks the round completed when children finish', () => {
        const tracker = new CodexCollaborationStateTracker();

        const started = tracker.applyEvent({
            type: 'codex_collaboration',
            call_id: 'spawn-1',
            tool: 'spawnAgent',
            status: 'inProgress',
            sender_thread_id: 'parent-thread',
            receiver_thread_ids: [],
            agents_states: {},
            time: 100
        });

        expect(started).toMatchObject({
            status: 'collaborating',
            active: true,
            activeCallCount: 1,
            childThreadCount: 0,
            lastEventAt: 100
        });

        const childPending = tracker.applyEvent({
            type: 'codex_collaboration',
            call_id: 'spawn-1',
            tool: 'spawnAgent',
            status: 'completed',
            sender_thread_id: 'parent-thread',
            receiver_thread_ids: ['child-thread'],
            agents_states: {
                'child-thread': { status: 'pendingInit' }
            },
            time: 150
        });

        expect(childPending).toMatchObject({
            status: 'collaborating',
            active: true,
            activeCallCount: 0,
            childThreadCount: 1,
            lastEventAt: 150,
            childThreads: [
                {
                    threadId: 'child-thread',
                    status: 'pendingInit',
                    active: true
                }
            ]
        });

        const completed = tracker.applyEvent({
            type: 'codex_collaboration',
            call_id: 'wait-1',
            tool: 'wait',
            status: 'completed',
            sender_thread_id: 'parent-thread',
            receiver_thread_ids: ['child-thread'],
            agents_states: {
                'child-thread': { status: 'completed', message: 'DONE' }
            },
            time: 200
        });

        expect(completed).toEqual({
            status: 'completed',
            active: false,
            activeCallCount: 0,
            childThreadCount: 1,
            childThreads: [
                {
                    threadId: 'child-thread',
                    status: 'completed',
                    message: 'DONE',
                    active: false
                }
            ],
            lastEventAt: 200,
            completedAt: 200
        });
    });

    it('marks a tracked child thread complete when the child thread becomes idle', () => {
        const tracker = new CodexCollaborationStateTracker();

        tracker.applyEvent({
            type: 'codex_collaboration',
            call_id: 'spawn-1',
            tool: 'spawnAgent',
            status: 'completed',
            receiver_thread_ids: ['child-thread'],
            agents_states: {
                'child-thread': { status: 'pendingInit' }
            },
            time: 100
        });

        const completed = tracker.applyThreadStatus({
            type: 'codex_thread_status',
            thread_id: 'child-thread',
            status: 'idle',
            time: 150
        });

        expect(completed).toEqual({
            status: 'completed',
            active: false,
            activeCallCount: 0,
            childThreadCount: 1,
            childThreads: [
                {
                    threadId: 'child-thread',
                    status: 'completed',
                    active: false
                }
            ],
            lastEventAt: 150,
            completedAt: 150
        });
    });

    it('resets completed child thread history before a new task starts', () => {
        const tracker = new CodexCollaborationStateTracker();

        tracker.applyEvent({
            type: 'codex_collaboration',
            call_id: 'wait-1',
            status: 'completed',
            receiver_thread_ids: ['old-child'],
            agents_states: {
                'old-child': { status: 'completed', message: 'Old result' }
            },
            time: 100
        });

        expect(tracker.reset(150)).toEqual({
            status: 'idle',
            active: false,
            activeCallCount: 0,
            childThreadCount: 0,
            childThreads: [],
            lastEventAt: 150
        });

        const next = tracker.applyEvent({
            type: 'codex_collaboration',
            call_id: 'spawn-2',
            status: 'completed',
            receiver_thread_ids: ['new-child'],
            agents_states: {
                'new-child': { status: 'running' }
            },
            time: 200
        });

        expect(next.childThreads).toEqual([
            {
                threadId: 'new-child',
                status: 'running',
                active: true
            }
        ]);
    });

    it('records recent child thread activity for the collaboration panel', () => {
        const tracker = new CodexCollaborationStateTracker();

        tracker.applyEvent({
            type: 'codex_collaboration',
            call_id: 'spawn-1',
            status: 'completed',
            receiver_thread_ids: ['child-thread'],
            agents_states: {
                'child-thread': { status: 'running' }
            },
            time: 100
        });

        const updated = tracker.applyThreadActivity({
            thread_id: 'child-thread',
            activity: {
                id: 'activity-1',
                type: 'message',
                text: 'Found validation gap',
                time: 125
            },
            time: 125
        });

        expect(updated).toMatchObject({
            status: 'collaborating',
            childThreads: [
                {
                    threadId: 'child-thread',
                    status: 'running',
                    active: true,
                    activities: [
                        {
                            id: 'activity-1',
                            type: 'message',
                            text: 'Found validation gap',
                            time: 125
                        }
                    ]
                }
            ]
        });
    });
});
