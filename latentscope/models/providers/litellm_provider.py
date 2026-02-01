"""
LiteLLM provider for latentscope.

Supports multiple LLM backends through litellm:
- OpenAI: openai/gpt-4o-mini, openai/gpt-4o
- Anthropic: anthropic/claude-3-5-sonnet-20241022
- Google: gemini/gemini-3-flash-preview, gemini/gemini-2.0-flash
- And many more: https://docs.litellm.ai/docs/providers

Usage:
    model_id = "litellm-gemini/gemini-3-flash-preview"
    model_id = "litellm-openai/gpt-4o-mini"
"""

import os
from .base import ChatModelProvider
from latentscope.util import get_key


class LiteLLMChatProvider(ChatModelProvider):
    """Chat provider using LiteLLM for multi-backend support."""

    def load_model(self):
        try:
            import litellm
        except ImportError:
            raise ImportError("litellm is required. Install with: pip install litellm")

        self.litellm = litellm

        # LiteLLM uses environment variables for API keys
        # OPENAI_API_KEY, ANTHROPIC_API_KEY, GEMINI_API_KEY, etc.
        # These should already be set in .env

        # For token counting, we use a simple fallback
        self.encoder = None
        try:
            import tiktoken
            self.encoder = tiktoken.encoding_for_model("gpt-4o")
        except Exception:
            pass

    def chat(self, messages):
        response = self.litellm.completion(
            model=self.name,
            messages=messages
        )
        return response.choices[0].message.content

    def summarize(self, items, context=""):
        from .prompts import summarize
        prompt = summarize(items, context)

        messages = [
            {"role": "user", "content": prompt}
        ]

        response = self.litellm.completion(
            model=self.name,
            messages=messages,
            max_tokens=100,
            temperature=0.3
        )
        return response.choices[0].message.content
