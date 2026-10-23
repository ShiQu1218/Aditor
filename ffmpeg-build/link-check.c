#include <libavcodec/avcodec.h>
#include <libavformat/avformat.h>
#include <libavutil/avutil.h>

int main(void) {
    return avcodec_version() && avformat_version() && avutil_version() ? 0 : 1;
}
