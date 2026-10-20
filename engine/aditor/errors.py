"""Shared exceptions, avoiding circular imports between analyze and calibrate."""


class Cancelled(Exception):
    pass
