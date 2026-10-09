"""Validated native-pixel regions reused from the verified collection geometry."""
import math

def _number(value, name, minimum=0, integer=False):
    if isinstance(value, bool) or not isinstance(value, (int,float)) or not math.isfinite(value):
        raise ValueError(f'{name} must be finite numeric data')
    if value < minimum or (integer and int(value) != value):
        raise ValueError(f'{name} is outside its allowed range')


def _edges(points):
    return list(zip(points,points[1:]+points[:1]))


def _cross(a,b,c):
    return (b[0]-a[0])*(c[1]-a[1])-(b[1]-a[1])*(c[0]-a[0])


def _on_segment(point,a,b):
    return _cross(a,b,point)==0 and all(min(a[i],b[i])<=point[i]<=max(a[i],b[i]) for i in (0,1))


def _segments_cross(a,b,c,d,include_boundary=False):
    if _cross(a,b,c)*_cross(a,b,d)<0 and _cross(c,d,a)*_cross(c,d,b)<0:
        return True
    return include_boundary and any((_on_segment(c,a,b),_on_segment(d,a,b),
                                     _on_segment(a,c,d),_on_segment(b,c,d)))


def _area_twice(points):
    return sum(a[0]*b[1]-b[0]*a[1] for a,b in _edges(points))


def _mask_polygon(mask):
    if 'points' in mask:
        return mask['points']
    x,y,width,height=(mask[name] for name in ('x','y','width','height'))
    return [[x,y],[x+width,y],[x+width,y+height],[x,y+height]]


def validate_mask(mask,reference_dimensions=None):
    """Validate one fixed region; dimensions use (height, width)."""
    if reference_dimensions is not None:
        if not isinstance(reference_dimensions,(list,tuple)) or len(reference_dimensions)!=2:
            raise ValueError('Camera reference dimensions require height and width')
        for value in reference_dimensions:
            _number(value,'Camera reference dimension',minimum=1,integer=True)
    if isinstance(mask,dict):
        if set(mask)=={'x','y','width','height'}:
            for key,value in mask.items():
                _number(value,'mask '+key,minimum=1 if key in ('width','height') else 0,integer=True)
            if reference_dimensions is not None and (mask['x']+mask['width']>reference_dimensions[1] or mask['y']+mask['height']>reference_dimensions[0]):
                raise ValueError('Camera mask lies outside the reference frame')
            return
        if set(mask)!={'points'}:
            raise ValueError('Camera masks require polygon points or rectangle coordinates')
        points=mask['points']
        if not isinstance(points,list) or len(points)<3:
            raise ValueError('Polygon masks require at least three vertices')
        for point in points:
            if not isinstance(point,list) or len(point)!=2 or any(type(value) is not int or value<0 for value in point):
                raise ValueError('Polygon vertices require nonnegative integer x and y')
            if reference_dimensions is not None and (point[0]>=reference_dimensions[1] or point[1]>=reference_dimensions[0]):
                raise ValueError('Polygon mask lies outside the reference frame')
        if len({tuple(point) for point in points})!=len(points) or _area_twice(points)==0:
            raise ValueError('Polygon masks require distinct vertices and nonzero area')
        edges=_edges(points)
        for index,(a,b) in enumerate(edges):
            previous=points[index-1]
            if _cross(previous,a,b)==0 and _on_segment(b,previous,a):
                raise ValueError('Polygon mask edges cannot double back')
            for other,(c,d) in enumerate(edges[index+1:],index+1):
                if other==index+1 or (index==0 and other==len(edges)-1):
                    continue
                if _segments_cross(a,b,c,d,include_boundary=True):
                    raise ValueError('Polygon masks must be simple without crossing edges')
        return
    if not isinstance(mask,list) or not mask or not isinstance(mask[0],list) or not mask[0]:
        raise ValueError('Camera masks require nonempty two-dimensional boolean arrays')
    if any(not isinstance(row,list) or len(row)!=len(mask[0]) or any(type(value) is not bool for value in row) for row in mask):
        raise ValueError('Camera masks require rectangular boolean arrays')
    if not any(value for row in mask for value in row):
        raise ValueError('Camera masks cannot be empty')
    if reference_dimensions is not None and (len(mask),len(mask[0]))!=tuple(reference_dimensions):
        raise ValueError('Camera mask dimensions differ from the reference frame')


def _inside_polygon(point,polygon):
    inside=False
    for a,b in _edges(polygon):
        if _on_segment(point,a,b):
            return False
        if (a[1]>point[1])!=(b[1]>point[1]) and point[0]<(b[0]-a[0])*(point[1]-a[1])/(b[1]-a[1])+a[0]:
            inside=not inside
    return inside


def _polygons_overlap(first,second):
    for polygon,other in ((first,second),(second,first)):
        if any(_inside_polygon(point,other) for point in polygon):
            return True
        if any(_inside_polygon([(a[0]+b[0])/2,(a[1]+b[1])/2],other) for a,b in _edges(polygon)):
            return True
    for a,b in _edges(first):
        for c,d in _edges(second):
            if _segments_cross(a,b,c,d):
                return True
            if _cross(a,b,c)==_cross(a,b,d)==0:
                axis=0 if a[0]!=b[0] else 1
                shared=max(min(a[axis],b[axis]),min(c[axis],d[axis]))<min(max(a[axis],b[axis]),max(c[axis],d[axis]))
                same_interior=((b[0]-a[0])*(d[0]-c[0])+(b[1]-a[1])*(d[1]-c[1]))*_area_twice(first)*_area_twice(second)>0
                if shared and same_interior:
                    return True
    return False


def validate_masks(masks,reference_dimensions=None):
    if masks is None:
        return
    if not isinstance(masks,dict) or not {'A','B'} <= set(masks):
        raise ValueError('Camera masks require regions A and B')
    backgrounds=[name for name in masks if name.startswith('background')]
    if not backgrounds:
        raise ValueError('Camera masks require static background references')
    selected=['A','B',*backgrounds]
    for name in selected:
        validate_mask(masks[name],reference_dimensions)
    if all(isinstance(masks[name],dict) for name in selected):
        def overlaps(first,second):
            return _polygons_overlap(_mask_polygon(masks[first]),_mask_polygon(masks[second]))
    elif all(isinstance(masks[name],list) for name in selected):
        if len({(len(masks[name]),len(masks[name][0])) for name in selected})!=1:
            raise ValueError('Camera mask dimensions must agree')
        def overlaps(first,second):
            return any(a and b for row_a,row_b in zip(masks[first],masks[second]) for a,b in zip(row_a,row_b))
    else:
        raise ValueError('Camera masks cannot mix pixel arrays with polygon or rectangle geometry')
    if overlaps('A','B') or any(overlaps(region,background) for region in ('A','B') for background in backgrounds):
        raise ValueError('Scoring and static-background masks must not overlap')
