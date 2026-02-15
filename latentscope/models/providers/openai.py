import os
import time
from .base import EmbedModelProvider, ChatModelProvider

from latentscope.util import get_key

class OpenAIEmbedProvider(EmbedModelProvider):
    def load_model(self):
        from openai import OpenAI
        import tiktoken
        api_key = get_key("OPENAI_API_KEY")
        if api_key is None:
            print("ERROR: No API key found for OpenAI")
            print("Missing 'OPENAI_API_KEY' variable in:", f"{os.getcwd()}/.env")

        base_url = get_key("OPENAI_BASE_URL")
        if base_url is not None:
            self.client = OpenAI(api_key=api_key, base_url=base_url)
        else:
            self.client = OpenAI(api_key=api_key)

        try:
            self.encoder = tiktoken.encoding_for_model(self.name)
        except KeyError:
            # Fallback for newer model aliases not yet mapped in local tiktoken.
            self.encoder = tiktoken.get_encoding("cl100k_base")

    def embed(self, inputs, dimensions=None):
        time.sleep(0.01) # TODO proper rate limiting
        enc = self.encoder
        max_tokens = self.params["max_tokens"]
        normalized_inputs = []
        for b in inputs:
            text = (b if b is not None else " ").replace("\n", " ")
            token_ids = enc.encode(text)
            if len(token_ids) > max_tokens:
                text = enc.decode(token_ids[:max_tokens])
            normalized_inputs.append(text)
        if dimensions is not None and dimensions > 0:
            response = self.client.embeddings.create(
                input=normalized_inputs,
                model=self.name,
                dimensions=dimensions
            )
        else:
            response = self.client.embeddings.create(
                input=normalized_inputs,
                model=self.name
            )
        embeddings = [embedding.embedding for embedding in response.data]
        return embeddings

class OpenAIChatProvider(ChatModelProvider):
    def load_model(self):
        from openai import OpenAI
        import tiktoken
        import outlines
        from outlines.models.openai import OpenAIConfig
        if self.base_url is None:
            self.client = OpenAI(api_key=get_key("OPENAI_API_KEY"))
            try:
                self.encoder = tiktoken.encoding_for_model(self.name)
            except KeyError:
                self.encoder = tiktoken.get_encoding("cl100k_base")
        else:
            self.client = OpenAI(api_key=get_key("OPENAI_API_KEY"), base_url=self.base_url)
            # even if this is some other model, we wont be able to figure out the tokenizer from custom API
            # so we just use gpt-4o as a fallback, it should be roughly correct for token counts
            self.encoder = tiktoken.encoding_for_model("gpt-4o")
        config = OpenAIConfig(self.name)
        self.model = outlines.models.openai(self.client, config)
        self.generator = outlines.generate.text(self.model)


    def chat(self, messages):
        response = self.client.chat.completions.create(
            model=self.name,
            messages=messages
        )
        return response.choices[0].message.content

