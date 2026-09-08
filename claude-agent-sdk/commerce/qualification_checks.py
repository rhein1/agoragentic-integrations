"""Optimization-stable checks shared by provider-free qualification drivers."""


def require(condition, message):
    """Raise explicitly when qualification evidence does not satisfy a contract."""
    if not condition:
        raise RuntimeError(message)
