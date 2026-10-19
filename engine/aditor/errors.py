"""共用例外（避免 analyze 與 calibrate 之間的循環匯入）。"""


class Cancelled(Exception):
    pass
