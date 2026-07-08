import path from "path"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { Effect } from "effect"
import { Agent } from "@/agent/agent"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { InstanceState } from "@/effect/instance-state"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { MessageID, PartID } from "./schema"
import { MessageV2 } from "./message-v2"
import { Session } from "./session"
import PROMPT_PLAN from "./prompt/plan.txt"
import BUILD_SWITCH from "./prompt/build-switch.txt"
import PLAN_MODE from "./prompt/plan-mode.txt"

function pushReminder(input: {
  messages: SessionV1.WithParts[]
  agent: Agent.Info
  userMessage: SessionV1.WithParts
  text: string
}) {
  const info = input.userMessage.info as SessionV1.User
  input.messages.push({
    info: {
      id: MessageID.ascending(),
      sessionID: info.sessionID,
      role: "user" as const,
      time: { created: Date.now() },
      agent: input.agent.name,
      model: info.model,
    },
    parts: [
      {
        id: PartID.ascending(),
        messageID: info.id,
        sessionID: info.sessionID,
        type: "text" as const,
        text: input.text,
        synthetic: true,
      },
    ],
  })
}

export const apply = Effect.fn("SessionReminders.apply")(function* (input: {
  messages: SessionV1.WithParts[]
  agent: Agent.Info
  session: Session.Info
}) {
  const flags = yield* RuntimeFlags.Service
  const fsys = yield* FSUtil.Service
  const sessions = yield* Session.Service
  const userMessage = input.messages.findLast((msg) => msg.info.role === "user")
  if (!userMessage) return input.messages

  if (!flags.experimentalPlanMode) {
    if (input.agent.name === "plan") {
      pushReminder({ messages: input.messages, agent: input.agent, userMessage, text: PROMPT_PLAN })
    }
    const wasPlan = input.messages.some((msg) => msg.info.role === "assistant" && msg.info.agent === "plan")
    if (wasPlan && input.agent.name === "build") {
      pushReminder({ messages: input.messages, agent: input.agent, userMessage, text: BUILD_SWITCH })
    }
    return input.messages
  }

  const assistantMessage = input.messages.findLast((msg) => msg.info.role === "assistant")
  if (input.agent.name !== "plan" && assistantMessage?.info.agent === "plan") {
    const ctx = yield* InstanceState.context
    const plan = Session.plan(input.session, ctx)
    const exists = yield* fsys.existsSafe(plan)
    pushReminder({
      messages: input.messages,
      agent: input.agent,
      userMessage,
      text: exists
        ? `${BUILD_SWITCH}\n\nA plan file exists at ${plan}. You should execute on the plan defined within it`
        : BUILD_SWITCH,
    })
    return input.messages
  }

  if (input.agent.name !== "plan" || assistantMessage?.info.agent === "plan") return input.messages

  const ctx = yield* InstanceState.context
  const plan = Session.plan(input.session, ctx)
  const exists = yield* fsys.existsSafe(plan)
  if (!exists) yield* fsys.ensureDir(path.dirname(plan)).pipe(Effect.catch(Effect.die))
  pushReminder({
    messages: input.messages,
    agent: input.agent,
    userMessage,
    text: PLAN_MODE.replace("${planInfo}", () =>
      exists
        ? `A plan file already exists at ${plan}. You can read it and make incremental edits using the edit tool.`
        : `No plan file exists yet. You should create your plan at ${plan} using the write tool.`,
    ),
  })
  return input.messages
})

export * as SessionReminders from "./reminders"
