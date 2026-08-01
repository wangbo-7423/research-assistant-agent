import { intentUnderstandingPrompt } from "./roleDefinition"
import { ChatCompletionTool } from "openai/resources/chat/completions"

// 工具：意图理解用户的追问问题
export const toolsData: ChatCompletionTool[] =[
    {
        "type": "function",
        "function": {
            "name": "意图识别",
            "description": intentUnderstandingPrompt,
            "parameters": {
                "type": "object",
                "properties": {
                    "clarified_question": {
                        "type": "string",
                        "description": "如果用户问题存在续问,结合上下文生成完整的新问题,若无续问,则忽略此字段",
                    }
                },
                "required": []
            }
        }
    }
]
