/* Just enough of the NDI SDK's declarations to syntax-check ndi/ndi-bridge.c in tests.
 * The real header comes from the NDI SDK when the Docker image is built. */
#pragma once
#include <stdbool.h>
#include <stdint.h>

typedef struct { const char *p_ndi_name; union { const char *p_url_address; const char *p_ip_address; }; } NDIlib_source_t;
typedef void *NDIlib_find_instance_t;
typedef void *NDIlib_recv_instance_t;
typedef void *NDIlib_framesync_instance_t;
typedef void *NDIlib_send_instance_t;
typedef struct { bool show_local_sources; const char *p_groups; const char *p_extra_ips; } NDIlib_find_create_t;
typedef enum { NDIlib_recv_color_format_UYVY_BGRA = 1 } NDIlib_recv_color_format_e;
typedef enum { NDIlib_recv_bandwidth_highest = 100 } NDIlib_recv_bandwidth_e;
typedef enum { NDIlib_frame_format_type_progressive = 1 } NDIlib_frame_format_type_e;
typedef enum { NDIlib_FourCC_video_type_UYVY = 1, NDIlib_FourCC_video_type_UYVA, NDIlib_FourCC_video_type_BGRA, NDIlib_FourCC_video_type_BGRX } NDIlib_FourCC_video_type_e;
typedef struct { NDIlib_source_t source_to_connect_to; NDIlib_recv_color_format_e color_format; NDIlib_recv_bandwidth_e bandwidth; bool allow_video_fields; const char *p_ndi_recv_name; } NDIlib_recv_create_v3_t;
typedef struct { int xres, yres; NDIlib_FourCC_video_type_e FourCC; int frame_rate_N, frame_rate_D; float picture_aspect_ratio; NDIlib_frame_format_type_e frame_format_type; int64_t timecode; uint8_t *p_data; union { int line_stride_in_bytes; int data_size_in_bytes; }; const char *p_metadata; int64_t timestamp; } NDIlib_video_frame_v2_t;
typedef struct { int sample_rate, no_channels, no_samples; int64_t timecode; float *p_data; int channel_stride_in_bytes; const char *p_metadata; int64_t timestamp; } NDIlib_audio_frame_v2_t;
typedef struct { const char *p_ndi_name; const char *p_groups; bool clock_video, clock_audio; } NDIlib_send_create_t;
static const int64_t NDIlib_send_timecode_synthesize = INT64_MAX;

bool NDIlib_initialize(void);
void NDIlib_destroy(void);
NDIlib_find_instance_t NDIlib_find_create_v2(const NDIlib_find_create_t *);
void NDIlib_find_destroy(NDIlib_find_instance_t);
bool NDIlib_find_wait_for_sources(NDIlib_find_instance_t, uint32_t);
const NDIlib_source_t *NDIlib_find_get_current_sources(NDIlib_find_instance_t, uint32_t *);
NDIlib_recv_instance_t NDIlib_recv_create_v3(const NDIlib_recv_create_v3_t *);
void NDIlib_recv_destroy(NDIlib_recv_instance_t);
int NDIlib_recv_get_no_connections(NDIlib_recv_instance_t);
NDIlib_framesync_instance_t NDIlib_framesync_create(NDIlib_recv_instance_t);
void NDIlib_framesync_destroy(NDIlib_framesync_instance_t);
void NDIlib_framesync_capture_video(NDIlib_framesync_instance_t, NDIlib_video_frame_v2_t *, NDIlib_frame_format_type_e);
void NDIlib_framesync_free_video(NDIlib_framesync_instance_t, NDIlib_video_frame_v2_t *);
void NDIlib_framesync_capture_audio(NDIlib_framesync_instance_t, NDIlib_audio_frame_v2_t *, int, int, int);
void NDIlib_framesync_free_audio(NDIlib_framesync_instance_t, NDIlib_audio_frame_v2_t *);
NDIlib_send_instance_t NDIlib_send_create(const NDIlib_send_create_t *);
void NDIlib_send_destroy(NDIlib_send_instance_t);
void NDIlib_send_send_video_async_v2(NDIlib_send_instance_t, const NDIlib_video_frame_v2_t *);
void NDIlib_send_send_audio_v2(NDIlib_send_instance_t, const NDIlib_audio_frame_v2_t *);
int NDIlib_send_get_no_connections(NDIlib_send_instance_t, uint32_t);
