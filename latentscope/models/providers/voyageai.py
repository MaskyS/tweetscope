import os
import time
import random
from .base import EmbedModelProvider


class VoyageAIEmbedProvider(EmbedModelProvider):
    def load_model(self):
        import voyageai
        from tokenizers import Tokenizer
        from latentscope.util import get_key
        api_key = get_key("VOYAGE_API_KEY")
        if api_key is None:
            raise ValueError(
                f"VOYAGE_API_KEY not found. Set it in {os.getcwd()}/.env or as an environment variable."
            )
        self.client = voyageai.Client(api_key)
        # The voyage client provides a tokenizer that only encodes https://docs.voyageai.com/tokenization/
        # It also says that it uses the same tokenizer as Llama 2
        self.encoder = Tokenizer.from_pretrained("TheBloke/Llama-2-70B-fp16")

    def embed(self, inputs, dimensions=None):
        # We truncate the input ourselves, even though the API supports truncation its still possible to send too big a batch
        enc = self.encoder
        max_tokens = self.params["max_tokens"]
        normalized_inputs = []
        for b in inputs:
            text = b if b is not None else " "
            token_ids = enc.encode(text).ids
            if len(token_ids) > max_tokens:
                text = enc.decode(token_ids[:max_tokens])
            normalized_inputs.append(text)

        max_retries = int(self.params.get("max_retries", 5))
        base_delay = float(self.params.get("retry_base_delay", 0.5))
        truncation = self.params.get("truncation", True)

        attempt = 0
        while True:
            try:
                response = self.client.embed(
                    texts=normalized_inputs,
                    model=self.name,
                    truncation=truncation,
                )
                return response.embeddings
            except Exception as e:
                attempt += 1
                err = str(e).lower()
                retryable = (
                    "429" in err
                    or "rate limit" in err
                    or "timeout" in err
                    or "temporar" in err
                    or "5xx" in err
                )
                if (not retryable) or attempt > max_retries:
                    raise
                sleep_s = base_delay * (2 ** (attempt - 1)) + random.uniform(0, 0.25)
                time.sleep(sleep_s)
