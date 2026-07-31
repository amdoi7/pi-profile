import type { AgentSession } from "@earendil-works/pi-coding-agent";
import type { Message } from "@earendil-works/pi-ai";

type SeedableSession = Pick<AgentSession, "sessionManager" | "agent">;

export function seedSideSessionMessages(session: SeedableSession, messages: Message[]): void {
	if (messages.length === 0) {
		return;
	}

	for (const message of messages) {
		session.sessionManager.appendMessage(message);
	}

	session.agent.state.messages = session.sessionManager.buildSessionContext().messages;
}
