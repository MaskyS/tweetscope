import json
from .providers.openai import OpenAIEmbedProvider, OpenAIChatProvider
from .providers.voyageai import VoyageAIEmbedProvider
from .providers.nltk import NLTKChatProvider
from .providers.litellm_provider import LiteLLMChatProvider

# We use a universal id system for models where its:
# <provider>-<model-name> with model-name replacing "/"" with "___"
# i.e. "nomic-ai/nomic-embed-text-v1.5" becomes: 
# "transformers-nomic-ai___nomic-embed-text-v1.5"
# or OpenAI's "text-embedding-3-small" becomes:
# "openai-text-embedding-3-small"

def get_embedding_model_list():
    """Returns a list of available embedding models."""
    from importlib.resources import files
    embedding_path = files('latentscope.models').joinpath('embedding_models.json')
    with open(embedding_path, "r") as f:
        embed_model_list = json.load(f)
    return embed_model_list

def get_embedding_model_dict(id):
    embed_model_list = get_embedding_model_list()
    embed_model_dict = {model['id']: model for model in embed_model_list}
    model = embed_model_dict[id]
    if not model:
        raise ValueError(f"Model {id} not found")
    return model

def get_embedding_model(id):
    """Returns a ModelProvider instance for the given model id."""
    model = get_embedding_model_dict(id)

    if model['provider'] == "openai":
        return OpenAIEmbedProvider(model['name'], model['params'])
    if model['provider'] == "voyageai":
        return VoyageAIEmbedProvider(model['name'], model['params'])
    raise ValueError(f"Unsupported embedding provider: {model['provider']}")


def get_chat_model_list():
    """Returns a list of available chat models."""
    from importlib.resources import files
    chat_path = files('latentscope.models').joinpath('chat_models.json')
    with open(chat_path, "r") as f:
        chat_model_list = json.load(f)
    return chat_model_list

def get_chat_model_dict(id):
    chat_model_list = get_chat_model_list()
    chat_model_dict = {model['id']: model for model in chat_model_list}
    model = chat_model_dict[id]
    if not model:
        raise ValueError(f"Model {id} not found")
    return model

def get_chat_model(id):
    """Returns a ModelProvider instance for the given model id."""
    if id.startswith("ollama-"):
        model = {
            "provider": "ollama",
            "name": id.split("ollama-")[1],
            "url": "http://localhost:11434/v1",
            "params": {}
        }
    elif id.startswith("litellm-"):
        # LiteLLM provider: litellm-gemini/gemini-3-flash-preview, litellm-openai/gpt-4o, etc.
        model = {
            "provider": "litellm",
            "name": id.split("litellm-")[1],  # e.g., "gemini/gemini-3-flash-preview"
            "params": {}
        }
    else:
        model = get_chat_model_dict(id)

    if model['provider'] == "openai":
        return OpenAIChatProvider(model['name'], model['params'])
    if model['provider'] == "ollama":
        return OpenAIChatProvider(model['name'], model['params'], base_url=model['url'])
    if model['provider'] == "nltk":
        return NLTKChatProvider(model['name'], model['params'])
    if model['provider'] == "litellm":
        return LiteLLMChatProvider(model['name'], model['params'])
    raise ValueError(f"Unsupported chat provider: {model['provider']}")

